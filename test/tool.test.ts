import { describe, expect, it } from "vitest";
import { createCronTool } from "../src/tool.js";
import type { CronJob } from "../src/types.js";

// Minimal in-memory CronStorage stand-in: implements just the surface the tool calls.
function makeStorage(seedJobs: CronJob[] = []) {
  const jobs = new Map<string, CronJob>(seedJobs.map((j) => [j.id, j]));
  return {
    hasJobWithName: (name: string) =>
      Array.from(jobs.values()).some((j) => j.name === name),
    addJob: (job: CronJob) => jobs.set(job.id, job),
    removeJob: (id: string) => jobs.delete(id),
    updateJob: (id: string, partial: Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return false;
      Object.assign(job, partial);
      return true;
    },
    getJob: (id: string) => jobs.get(id),
    getAllJobs: () => Array.from(jobs.values()),
    getStorePath: () => ":memory:",
  } as any;
}

// Scheduler stub: tool calls addJob/removeJob/updateJob/getNextRun. None of these
// matter for validation tests — they're invoked only after validation passes.
function makeScheduler() {
  return {
    addJob: () => {},
    removeJob: () => {},
    updateJob: () => {},
    getNextRun: () => null,
  } as any;
}

// Tool's recursion guard reads ctx.sessionManager.getEntries(); empty array bypasses it.
function makeCtx() {
  return { sessionManager: { getEntries: () => [] } } as any;
}

function buildTool(seedJobs: CronJob[] = []) {
  const storage = makeStorage(seedJobs);
  const scheduler = makeScheduler();
  const tool = createCronTool(
    () => storage,
    () => scheduler,
  );
  return { tool, storage };
}

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "abc1234567",
    name: "demo",
    schedule: "+10s",
    prompt: "test",
    enabled: true,
    type: "once",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("schedule_prompt — notify behavior", () => {
  describe("add", () => {
    it("accepts notify=true without model (no-op for inline jobs)", async () => {
      const { tool } = buildTool();
      const result = await tool.execute(
        "call",
        {
          action: "add",
          schedule: "+10s",
          type: "once",
          prompt: "test",
          notify: true,
        } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
      expect(result.details?.jobs?.[0].notify).toBe(true);
      expect(result.details?.jobs?.[0].model).toBeUndefined();
    });

    it("accepts notify=true with model", async () => {
      const { tool } = buildTool();
      const result = await tool.execute(
        "call",
        {
          action: "add",
          schedule: "+10s",
          type: "once",
          prompt: "test",
          notify: true,
          model: "haiku",
        } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
      expect(result.details?.jobs?.[0].model).toBe("haiku");
      expect(result.details?.jobs?.[0].notify).toBe(true);
    });

    it("accepts notify=false without model", async () => {
      const { tool } = buildTool();
      const result = await tool.execute(
        "call",
        {
          action: "add",
          schedule: "+10s",
          type: "once",
          prompt: "test",
          notify: false,
        } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
    });

    it("accepts model without notify (defaults to silent)", async () => {
      const { tool } = buildTool();
      const result = await tool.execute(
        "call",
        {
          action: "add",
          schedule: "+10s",
          type: "once",
          prompt: "test",
          model: "haiku",
        } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
      expect(result.details?.jobs?.[0].notify).toBeUndefined();
    });
  });

  describe("update", () => {
    it("accepts setting notify=true on an existing inline (no-model) job (no-op)", async () => {
      const { tool } = buildTool([exampleJob({ id: "j1" })]);
      const result = await tool.execute(
        "call",
        { action: "update", jobId: "j1", notify: true } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
    });

    it("accepts setting notify=true alongside model in the same call", async () => {
      const { tool } = buildTool([exampleJob({ id: "j2" })]);
      const result = await tool.execute(
        "call",
        { action: "update", jobId: "j2", notify: true, model: "haiku" } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
    });

    it("accepts setting notify=true on a job that already has model", async () => {
      const { tool } = buildTool([exampleJob({ id: "j3", model: "haiku" })]);
      const result = await tool.execute(
        "call",
        { action: "update", jobId: "j3", notify: true } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
    });

    it("accepts clearing model even when notify is still true (no-op for inline)", async () => {
      const { tool } = buildTool([
        exampleJob({ id: "j4", model: "haiku", notify: true }),
      ]);
      const result = await tool.execute(
        "call",
        { action: "update", jobId: "j4", model: "" } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
    });

    it("accepts clearing model when notify is also being cleared", async () => {
      const { tool } = buildTool([
        exampleJob({ id: "j5", model: "haiku", notify: true }),
      ]);
      const result = await tool.execute(
        "call",
        { action: "update", jobId: "j5", model: "", notify: false } as any,
        undefined,
        undefined,
        makeCtx(),
      );
      expect(result.details?.error).toBeUndefined();
    });
  });
});
