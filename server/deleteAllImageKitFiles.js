import express from "express";
import "dotenv/config";
import ImageKit from "imagekit";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

// ImageKit setup
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const PAGE_SIZE = 100; // Number of files to fetch per page
const DELETE_BATCH = 100; // Number of files to delete per batch
const dryRun = process.env.IMAGEKIT_DELETE_DRY_RUN === "1";
const LIMIT_PAGES = Number(process.env.LIMIT_PAGES) || 0; // Limit number of pages to process (0 = unlimited)

// Supabase table configuration - customize to match your database schema
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "images";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const deleteBatch = async (fileIds) => {
  if (dryRun) {
    console.log(
      `[DRY RUN] Would delete ${fileIds.length} files from ImageKit.`,
    );
    return;
  }

  // Delete from ImageKit
  await imagekit.bulkDeleteFiles(fileIds);
  console.log(`[ImageKit] Deleted ${fileIds.length} files.`);
};

const deleteAllFiles = async () => {
  let totalDeleted = 0;
  let offset = 0;

  while (true) {
    const filesResponse = await imagekit.listFiles({
      skip: offset,
      limit: PAGE_SIZE,
    });

    // Support both response formats
    const files = Array.isArray(filesResponse)
      ? filesResponse
      : filesResponse.items || [];

    console.log(`Offset ${offset}: Found ${files.length} files.`);

    if (files.length === 0) break;

    const fileIds = files.map((f) => f.fileId).filter(Boolean);

    for (let i = 0; i < fileIds.length; i += DELETE_BATCH) {
      const chunk = fileIds.slice(i, i + DELETE_BATCH);
      let done = false;

      while (!done) {
        try {
          await deleteBatch(chunk);
          totalDeleted += chunk.length;
          done = true;
        } catch (error) {
          const status = error?.$ResponseMetadata?.statusCode;
          const resetMs =
            Number(error?.$ResponseMetadata?.headers?.["x-ratelimit-reset"]) ||
            0;

          if (status === 429 && resetMs > 0) {
            console.log(`Rate limited. Waiting ${resetMs}ms...`);
            await sleep(resetMs);
            continue;
          }
          throw error;
        }
      }
    }

    offset += PAGE_SIZE;
  }

  // Reset total_uploaded counter in Supabase after all files are deleted
  if (!dryRun && totalDeleted > 0) {
    const { data, error } = await supabase
      .from(SUPABASE_TABLE)
      .update({ total_uploaded: 1024 })
      .eq("id", 15)
      .select();

    if (error) {
      console.error("[Supabase] Update error:", error.message);
      throw new Error(`Supabase update failed: ${error.message}`);
    }

    console.log("[Supabase] Reset total_uploaded to 0.");
  }

  return dryRun
    ? "Dry run complete. No files were deleted."
    : `All done. Total ImageKit files deleted: ${totalDeleted}.`;
};

app.post("/api/delete-imagekit", async (req, res) => {
  const confirm = process.env.CONFIRM_DELETE_ALL_IMAGEKIT;
  if (confirm !== "YES") {
    return res.status(403).json({
      success: false,
      error:
        "Refusing to delete. Set CONFIRM_DELETE_ALL_IMAGEKIT=YES to enable.",
    });
  }

  try {
    const result = await deleteAllFiles();
    res.json({ success: true, message: result });
  } catch (error) {
    console.error("Delete-all failed:", error);
    res
      .status(500)
      .json({ success: false, error: error.message || error.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
