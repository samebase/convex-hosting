#!/usr/bin/env node
import { nodeCli } from "./convex.js";
import { main } from "./main.js";

process.exitCode = await main(process.argv.slice(2), nodeCli);
