import { z } from "zod";
import { jsonResult } from "./_format.js";
import * as core from "../core/morning.js";

export function registerMorningTools(server) {
  server.tool(
    "morning_brief",
    "Scan one watchlist, read all indicator values, and return structured data for a session brief. Reads rules.json for your bias criteria and watchlists. Claude applies the rules to generate your daily bias. Scanning retargets the chart once per symbol (~2s each), so run one named watchlist at a time.",
    {
      rules_path: z
        .string()
        .optional()
        .describe(
          "Optional path to rules.json. Defaults to rules.json in the project root.",
        ),
      watchlist: z
        .string()
        .optional()
        .describe(
          "Name of the watchlist group in rules.json to scan (e.g. 'fx_commodities'). Defaults to default_watchlist.",
        ),
    },
    async ({ rules_path, watchlist } = {}) => {
      try {
        return jsonResult(await core.runBrief({ rules_path, watchlist }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_save",
    "Save today's morning brief to ~/.tradingview-mcp/sessions/YYYY-MM-DD.json for future reference.",
    {
      brief: z
        .string()
        .describe(
          "The brief text to save (output from morning_brief after Claude applies the rules).",
        ),
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ brief, date } = {}) => {
      try {
        return jsonResult(core.saveSession({ brief, date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_get",
    "Retrieve a saved session brief. Returns today's if available, otherwise yesterday's.",
    {
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ date } = {}) => {
      try {
        return jsonResult(core.getSession({ date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
