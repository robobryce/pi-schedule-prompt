/**
 * pi-schedule-prompt — A pi extension for scheduling agent prompts
 *
 * Provides:
 * - A `schedule_prompt` tool for managing scheduled prompts
 * - A widget displaying all scheduled prompts with status
 * - /schedule-prompt command for interactive management
 * - Persistence via .pi/schedule-prompts.json (jobs) and .pi/schedule-prompts-settings.json (settings)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { nanoid } from "nanoid";
import { CronScheduler } from "./scheduler.js";
import { loadSettings, saveSettings, type ScheduleSettings } from "./settings.js";
import { CronStorage } from "./storage.js";
import { createCronTool } from "./tool.js";
import { CronWidget } from "./ui/cron-widget.js";

export default async function (pi: ExtensionAPI) {
  let storage: CronStorage;
  let scheduler: CronScheduler;
  let widget: CronWidget;
  // Refreshed in initializeSession; mutated by Settings submenu. The tool and
  // widget read via closure so toggles take effect without re-registering.
  let settings: ScheduleSettings = {};
  const isWidgetVisible = () => settings.widgetVisible !== false;

  // Register custom message renderer for scheduled prompts
  pi.registerMessageRenderer("scheduled_prompt", (message, _options, theme) => {
    const details = message.details as
      | {
          jobId: string;
          jobName: string;
          prompt: string;
          mode?: "subagent_start" | "subagent_done" | "subagent_error";
          model?: string;
          output?: string;
          error?: string;
        }
      | undefined;
    const jobName = details?.jobName || "Unknown";
    const prompt = details?.prompt || "";
    const model = details?.model;
    const tag = model ? ` (subagent: ${model})` : "";

    let line: string;
    switch (details?.mode) {
      case "subagent_start":
        line =
          theme.fg("accent", `🕐 Scheduled${tag}: ${jobName}`) +
          (prompt ? theme.fg("dim", ` → "${prompt}"`) : "");
        break;
      case "subagent_done":
        line =
          theme.fg("accent", `✓ Scheduled${tag} finished: ${jobName}`) +
          (details?.output ? theme.fg("dim", ` → ${details.output}`) : "");
        break;
      case "subagent_error":
        line =
          theme.fg("error", `✗ Scheduled${tag} failed: ${jobName}`) +
          (details?.error ? theme.fg("dim", ` → ${details.error}`) : "");
        break;
      default:
        line =
          theme.fg("accent", `🕐 Scheduled: ${jobName}`) +
          (prompt ? theme.fg("dim", ` → "${prompt}"`) : "");
    }

    return new Text(line, 0, 0);
  });

  // Register the tool once with getter functions
  const tool = createCronTool(
    () => storage,
    () => scheduler,
    () => settings.defaultJobScope ?? "session",
  );
  pi.registerTool(tool);

  // --- Session initialization ---

  const initializeSession = (ctx: any) => {
    // Idempotent: tear down any prior instance before creating a new one.
    // Without this, every `session_start` (fires on reload/resume/fork too, not
    // only on fresh startup) leaks a live croner timer into the event loop,
    // accumulating duplicate fires for every recurring job over time.
    cleanupSession(ctx);

    settings = loadSettings(ctx.cwd);
    storage = new CronStorage(ctx.cwd);
    scheduler = new CronScheduler(storage, pi, ctx);
    widget = new CronWidget(storage, scheduler, pi, isWidgetVisible, ctx.sessionManager.getSessionId());

    scheduler.start();

    // Show widget
    if (isWidgetVisible()) {
      widget.show(ctx);
    }
  };

  const cleanupSession = (ctx: any) => {
    // Stop scheduler
    if (scheduler) {
      scheduler.stop();
    }

    // Hide widget
    if (widget) {
      widget.hide(ctx);
      widget.destroy();
    }
  };

  const autoCleanupDisabledJobs = (ctx: any) => {
    // Only sweep our own (or unbound) disabled jobs — never another session's.
    if (!storage) return;
    const mySessionId = ctx.sessionManager.getSessionId();
    const disabledJobs = storage
      .getAllJobs()
      .filter((j) => !j.enabled && CronScheduler.isLoadedFor(j, mySessionId));

    if (disabledJobs.length > 0) {
      console.log(`Auto-cleanup: removing ${disabledJobs.length} disabled job(s)`);
      for (const job of disabledJobs) {
        storage.removeJob(job.id);
      }
    }
  };

  // --- Lifecycle events ---

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") {
      autoCleanupDisabledJobs(ctx);
    }
    initializeSession(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    autoCleanupDisabledJobs(ctx);
    cleanupSession(ctx);
  });

  // --- Register /schedule-prompt command ---

  pi.registerCommand("schedule-prompt", {
    description: "Manage scheduled prompts interactively",
    handler: async (_args, ctx) => {
      const mySessionId = ctx.sessionManager.getSessionId();
      const myJobs = () =>
        storage
          .getAllJobs()
          .filter((j) => CronScheduler.isLoadedFor(j, mySessionId));

      const action = await ctx.ui.select("Scheduled Prompts", [
        "View All Jobs",
        "Add New Job",
        "Toggle Job (Enable/Disable)",
        "Remove Job",
        "Cleanup Disabled Jobs",
        "Settings",
      ]);

      if (!action) return;

      const actionMap: Record<string, string> = {
        "View All Jobs": "list",
        "Add New Job": "add",
        "Toggle Job (Enable/Disable)": "toggle",
        "Remove Job": "remove",
        "Cleanup Disabled Jobs": "cleanup",
        "Settings": "settings",
      };
      const actionKey = actionMap[action];

      switch (actionKey) {
        case "list": {
          const jobs = myJobs();
          if (jobs.length === 0) {
            ctx.ui.notify("No scheduled prompts configured", "info");
            return;
          }

          const lines = ["Scheduled prompts:", ""];
          for (const job of jobs) {
            const status = job.enabled ? "✓" : "✗";
            const nextRun = scheduler.getNextRun(job.id);
            lines.push(`${status} ${job.name} (${job.id})`);
            lines.push(`  Schedule: ${job.schedule} | Type: ${job.type}`);
            lines.push(`  Prompt: ${job.prompt}`);
            if (nextRun) {
              lines.push(`  Next run: ${nextRun.toISOString()}`);
            }
            lines.push(`  Runs: ${job.runCount}`);
            lines.push("");
          }

          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "add": {
          const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
          if (!name) return;

          const typeChoice = await ctx.ui.select("Job Type", [
            "Cron (recurring)",
            "Once (one-shot)",
            "Interval (periodic)",
          ]);
          if (!typeChoice) return;

          const typeMap: Record<string, string> = {
            "Cron (recurring)": "cron",
            "Once (one-shot)": "once",
            "Interval (periodic)": "interval",
          };
          const jobType = typeMap[typeChoice];

          let schedulePrompt: string;
          if (jobType === "cron") {
            schedulePrompt = "Enter cron expression (6-field: sec min hour dom month dow):";
          } else if (jobType === "once") {
            schedulePrompt = "Enter ISO timestamp (e.g., 2026-02-13T10:30:00Z)";
          } else {
            schedulePrompt = "Enter interval (e.g., 5m, 1h, 30s)";
          }

          const scheduleRaw = await ctx.ui.input("Schedule", schedulePrompt);
          if (!scheduleRaw) return;
          const schedule = scheduleRaw.trim();

          const prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute");
          if (!prompt) return;

          // Validate and create job
          try {
            let intervalMs: number | undefined;
            let validatedSchedule = schedule;

            if (jobType === "interval") {
              const parsed = CronScheduler.parseInterval(schedule);
              intervalMs = parsed !== null ? parsed : undefined;
              if (!intervalMs) {
                ctx.ui.notify("Invalid interval format", "error");
                return;
              }
            } else if (jobType === "once") {
              const date = new Date(schedule);
              if (Number.isNaN(date.getTime())) {
                ctx.ui.notify("Invalid timestamp format", "error");
                return;
              }
              validatedSchedule = date.toISOString();
            } else {
              const validation = CronScheduler.validateCronExpression(schedule);
              if (!validation.valid) {
                ctx.ui.notify(`Invalid cron expression: ${validation.error}`, "error");
                return;
              }
            }

            const session =
              (settings.defaultJobScope ?? "session") === "session" ? mySessionId : undefined;
            const job = {
              id: nanoid(10),
              name,
              schedule: validatedSchedule,
              prompt,
              enabled: true,
              type: jobType as any,
              intervalMs,
              createdAt: new Date().toISOString(),
              runCount: 0,
              session,
            };

            storage.addJob(job);
            scheduler.addJob(job);
            ctx.ui.notify(`Created scheduled prompt: ${name}`, "info");
          } catch (error: any) {
            ctx.ui.notify(`Error: ${error.message}`, "error");
          }
          break;
        }

        case "toggle": {
          const jobs = myJobs();
          if (jobs.length === 0) {
            ctx.ui.notify("No scheduled prompts configured", "info");
            return;
          }

          const jobId = await ctx.ui.select(
            "Select Job to Toggle",
            jobs.map((j) => `${j.enabled ? "✓" : "✗"} ${j.name}`)
          );

          if (!jobId) return;

          // Find job by matching the label
          const selectedIndex = jobs.findIndex(
            (j) => `${j.enabled ? "✓" : "✗"} ${j.name}` === jobId
          );
          const job = selectedIndex >= 0 ? jobs[selectedIndex] : undefined;
          if (job) {
            const newEnabled = !job.enabled;
            storage.updateJob(job.id, { enabled: newEnabled });
            const updated = { ...job, enabled: newEnabled };
            scheduler.updateJob(job.id, updated);
            ctx.ui.notify(`${newEnabled ? "Enabled" : "Disabled"} job: ${job.name}`, "info");
          }
          break;
        }

        case "remove": {
          const jobs = myJobs();
          if (jobs.length === 0) {
            ctx.ui.notify("No scheduled prompts configured", "info");
            return;
          }

          const jobId = await ctx.ui.select(
            "Select Job to Remove",
            jobs.map((j) => j.name)
          );

          if (!jobId) return;

          // Find job by name
          const job = jobs.find((j) => j.name === jobId);
          if (job) {
            const confirmed = await ctx.ui.confirm(
              "Confirm Removal",
              `Remove scheduled prompt "${job.name}"?`
            );

            if (confirmed) {
              storage.removeJob(job.id);
              scheduler.removeJob(job.id);
              ctx.ui.notify(`Removed job: ${job.name}`, "info");
            }
          }
          break;
        }

        case "cleanup": {
          const jobs = myJobs();
          const disabledJobs = jobs.filter((j) => !j.enabled);

          if (disabledJobs.length === 0) {
            ctx.ui.notify("No disabled jobs to clean up", "info");
            return;
          }

          const confirmed = await ctx.ui.confirm(
            "Confirm Cleanup",
            `Remove ${disabledJobs.length} disabled job(s)?`
          );

          if (confirmed) {
            for (const job of disabledJobs) {
              storage.removeJob(job.id);
              scheduler.removeJob(job.id);
            }
            ctx.ui.notify(`Removed ${disabledJobs.length} disabled job(s)`, "info");
          }
          break;
        }

        case "settings": {
          // Loop so the menu redraws with current state after each change —
          // the menu is the truth display; only persist failures need a toast.
          while (true) {
            const widgetState = isWidgetVisible() ? "shown" : "hidden";
            const bound = (settings.defaultJobScope ?? "session") === "session";
            const choice = await ctx.ui.select("Settings", [
              `Widget visibility: ${widgetState}`,
              `Bind new jobs to session: ${bound ? "yes" : "no"}`,
              "Back",
            ]);
            if (!choice || choice === "Back") return;
            if (choice.startsWith("Widget visibility:")) {
              const next = !isWidgetVisible();
              settings = { ...settings, widgetVisible: next };
              next ? widget.show(ctx) : widget.hide(ctx);
              const persisted = saveSettings(ctx.cwd, settings);
              if (!persisted) {
                ctx.ui.notify(
                  `Widget ${next ? "shown" : "hidden"} (session only; failed to persist)`,
                  "warning",
                );
              }
            } else if (choice.startsWith("Bind new jobs to session:")) {
              // Affects newly-created jobs only; existing jobs keep their binding.
              const next = bound ? "workdir" : "session";
              settings = { ...settings, defaultJobScope: next };
              const persisted = saveSettings(ctx.cwd, settings);
              if (!persisted) {
                ctx.ui.notify(
                  `Bind new jobs to session: ${next === "session" ? "yes" : "no"} (session only; failed to persist)`,
                  "warning",
                );
              }
            }
          }
        }
      }
    },
  });
}
