import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { action } from "./_generated/server.js";

/** Proves native uploads and file operations through a nested component. */
export const run = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const path = `smoke/${crypto.randomUUID()}/hello.txt`;
    const text = "Hello from a nested file component.";
    const uploadUrl = await ctx.runMutation(components.files.lib.generateUploadUrl, {});
    const uploaded = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text,
    });
    if (!uploaded.ok) throw new Error(`Upload failed: ${uploaded.status}`);
    const result: unknown = await uploaded.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("storageId" in result) ||
      typeof result.storageId !== "string"
    ) {
      throw new Error("Upload returned no storage ID.");
    }
    const fileId = await ctx.runMutation(components.files.lib.register, {
      path,
      storageId: result.storageId,
    });
    try {
      const file = await ctx.runQuery(components.files.lib.getByPath, { path });
      if (
        !file?.url ||
        file._id !== fileId ||
        file.metadata?.size !== text.length ||
        file.metadata.contentType !== "text/plain"
      ) {
        throw new Error("File lookup did not return the uploaded file.");
      }
      const downloaded = await fetch(file.url);
      if (!downloaded.ok || (await downloaded.text()) !== text) {
        throw new Error("File contents differ from the uploaded text.");
      }
      const listed = await ctx.runQuery(components.files.lib.list, {
        prefix: path,
        paginationOpts: { cursor: null, numItems: 1 },
      });
      if (listed.page[0]?._id !== fileId) throw new Error("File listing omitted the upload.");
      const renamedPath = `${path}.renamed`;
      await ctx.runMutation(components.files.lib.rename, { fileId, path: renamedPath });
      const renamed = await ctx.runQuery(components.files.lib.get, { fileId });
      if (renamed?.path !== renamedPath || renamed.storageId !== result.storageId) {
        throw new Error("Rename changed the file identity.");
      }
    } finally {
      await ctx.runMutation(components.files.lib.remove, { fileId });
    }
    if ((await ctx.runQuery(components.files.lib.get, { fileId })) !== null) {
      throw new Error("File was not removed.");
    }
    // Scan with a zero cutoff to verify system-table paging without deleting other uploads.
    await ctx.runMutation(components.files.lib.cleanupUnregistered, {
      before: 0,
      cursor: result.storageId,
    });
    return null;
  },
});
