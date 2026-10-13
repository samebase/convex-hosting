import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("cleanup", { hours: 1 }, internal.lib.cleanup, {});

export default crons;
