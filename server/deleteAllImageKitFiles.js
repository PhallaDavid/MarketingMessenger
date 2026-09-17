import express from "express";
import "dotenv/config";
import ImageKit from "imagekit";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanParam = (val) => {
  if (typeof val === "string") {
    // URL query string parsing converts '+' to ' ' if unencoded. Fix spaces back to '+' for base64/keys.
    return val.trim().replace(/ /g, "+");
  }
  return val;
};

/**
 * Extracts configuration from URL query parameters, falling back to process.env
 */
const getConfig = (req) => {
  const query = req.query || {};

  const publicKey = cleanParam(
    query.IMAGEKIT_PUBLIC_KEY ||
      query.publicKey ||
      query.public_key ||
      process.env.IMAGEKIT_PUBLIC_KEY ||
      "public_5MQz6ok1zqGrfmTPr1bD7wps+qc="
  );

  const privateKey = cleanParam(
    query.IMAGEKIT_PRIVATE_KEY ||
      query.privateKey ||
      process.env.IMAGEKIT_PRIVATE_KEY
  );

  const urlEndpoint =
    query.IMAGEKIT_URL_ENDPOINT ||
    query.urlEndpoint ||
    process.env.IMAGEKIT_URL_ENDPOINT;

  const supabaseUrl =
    query.SUPABASE_URL ||
    query.supabaseUrl ||
    process.env.SUPABASE_URL;

  const supabaseKey =
    query.SUPABASE_SERVICE_ROLE_KEY ||
    query.supabaseServiceRoleKey ||
    query.supabaseKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  const supabaseTable =
    query.SUPABASE_TABLE ||
    query.supabaseTable ||
    process.env.SUPABASE_TABLE ||
    "imagekits";

  const confirmRaw =
    query.CONFIRM_DELETE_ALL_IMAGEKIT ||
    query.confirm ||
    process.env.CONFIRM_DELETE_ALL_IMAGEKIT;

  const dryRunRaw =
    query.IMAGEKIT_DELETE_DRY_RUN ??
    query.dryRun ??
    process.env.IMAGEKIT_DELETE_DRY_RUN;

  const dryRun =
    dryRunRaw === "1" ||
    dryRunRaw === "true" ||
    dryRunRaw === true;

  const confirm =
    typeof confirmRaw === "string" ? confirmRaw.trim().toUpperCase() : confirmRaw;

  const keepHoursRaw =
    query.keepHours ??
    query.KEEP_HOURS ??
    query.keepLastHours ??
    query.keepLastHour ??
    query.keepHour ??
    query.hours ??
    process.env.KEEP_HOURS;

  const keepDaysRaw =
    query.keepDays ??
    query.KEEP_DAYS ??
    query.keepLastDays ??
    query.keepLastDay ??
    query.keepDay ??
    query.days ??
    process.env.KEEP_DAYS;

  let keepHours;
  if (keepHoursRaw !== undefined && keepHoursRaw !== null && keepHoursRaw !== "") {
    keepHours = Number(keepHoursRaw);
  } else if (keepDaysRaw !== undefined && keepDaysRaw !== null && keepDaysRaw !== "") {
    keepHours = Number(keepDaysRaw) * 24;
  } else {
    // Default to 24 hours (1 day) if not specified
    keepHours = 24;
  }

  const keepDays = keepHours / 24;

  return {
    publicKey,
    privateKey,
    urlEndpoint,
    supabaseUrl,
    supabaseKey,
    supabaseTable,
    confirm,
    dryRun,
    keepHours,
    keepDays,
  };
};

const deleteBatch = async (imagekit, fileIds, dryRun) => {
  if (dryRun) {
    console.log(
      `[DRY RUN] Would delete ${fileIds.length} files from ImageKit.`
    );
    return;
  }

  // Delete from ImageKit
  try {
    await imagekit.bulkDeleteFiles(fileIds);
    console.log(`[ImageKit] Bulk deleted ${fileIds.length} files.`);
  } catch (err) {
    const errMsg = err?.message || err?.toString() || "";
    const isMissingFileErr =
      errMsg.includes("does not exist") ||
      err?.$ResponseMetadata?.statusCode === 404;

    if (isMissingFileErr) {
      console.log(
        `[ImageKit] Bulk delete encountered missing/already-deleted file(s). Deleting individually...`
      );
      for (const fileId of fileIds) {
        try {
          await imagekit.deleteFile(fileId);
        } catch (singleErr) {
          const sMsg = singleErr?.message || singleErr?.toString() || "";
          if (
            !sMsg.includes("does not exist") &&
            singleErr?.$ResponseMetadata?.statusCode !== 404
          ) {
            console.warn(
              `[ImageKit] Failed to delete individual file ${fileId}:`,
              sMsg
            );
          }
        }
      }
    } else {
      throw err;
    }
  }
};

const deleteAllFiles = async (config) => {
  const {
    publicKey,
    privateKey,
    urlEndpoint,
    supabaseUrl,
    supabaseKey,
    supabaseTable,
    dryRun,
    keepHours,
    keepDays,
  } = config;

  if (!privateKey || !urlEndpoint) {
    throw new Error(
      "Missing ImageKit credentials. Please provide IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT via URL query parameters or .env file."
    );
  }

  const imagekit = new ImageKit({
    publicKey: publicKey || "",
    privateKey: privateKey,
    urlEndpoint: urlEndpoint,
  });

  const PAGE_SIZE = 100;
  const DELETE_BATCH = 100;
  let totalDeleted = 0;
  let totalKept = 0;
  let offset = 0;

  const now = Date.now();
  const cutoffTime =
    keepHours > 0 ? now - keepHours * 60 * 60 * 1000 : null;

  const seenFileIds = new Set();
  let consecutiveEmptyPages = 0;

  while (true) {
    const filesResponse = await imagekit.listFiles({
      skip: offset,
      limit: PAGE_SIZE,
    });

    const files = Array.isArray(filesResponse)
      ? filesResponse
      : filesResponse?.items || [];

    console.log(`Offset ${offset}: Found ${files.length} files.`);

    if (files.length === 0) break;

    // Filter out files that have already been processed in previous iterations
    const newFiles = files.filter((f) => f.fileId && !seenFileIds.has(f.fileId));

    if (newFiles.length === 0) {
      consecutiveEmptyPages++;
      offset += PAGE_SIZE;
      if (consecutiveEmptyPages >= 3) {
        console.log(`No new unprocessed files found across consecutive pages. Finished pagination.`);
        break;
      }
      continue;
    }

    consecutiveEmptyPages = 0;
    for (const f of newFiles) {
      seenFileIds.add(f.fileId);
    }

    let filesToDelete = [];
    let filesToKeep = [];

    if (cutoffTime) {
      for (const f of newFiles) {
        const fileTime = new Date(f.createdAt).getTime();
        if (fileTime >= cutoffTime) {
          filesToKeep.push(f);
        } else {
          filesToDelete.push(f);
        }
      }
    } else {
      filesToDelete = newFiles;
    }

    totalKept += filesToKeep.length;

    const fileIdsToDelete = filesToDelete.map((f) => f.fileId).filter(Boolean);

    for (let i = 0; i < fileIdsToDelete.length; i += DELETE_BATCH) {
      const chunk = fileIdsToDelete.slice(i, i + DELETE_BATCH);
      let done = false;

      while (!done) {
        try {
          await deleteBatch(imagekit, chunk, dryRun);
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

    if (dryRun) {
      offset += PAGE_SIZE;
    } else {
      // Advance offset by count of kept files. If no files were kept in this page, advance by PAGE_SIZE to ensure we never stall.
      offset += filesToKeep.length > 0 ? filesToKeep.length : PAGE_SIZE;
    }
  }

  // Update total_uploaded counter in Supabase after files are processed
  if (!dryRun && totalDeleted > 0 && supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { error } = await supabase
        .from(supabaseTable)
        .update({ total_uploaded: totalKept })
        .eq("id", 15)
        .select();

      if (error) {
        console.error("[Supabase] Update error:", error.message);
      } else {
        console.log(`[Supabase] Reset total_uploaded to ${totalKept}.`);
      }
    } catch (err) {
      console.error("[Supabase] Supabase update skipped/failed:", err.message);
    }
  }

  const modeStr = dryRun ? "Dry run complete." : "All done.";
  const timeUnitStr =
    keepHours > 0
      ? keepHours % 24 === 0
        ? `${keepHours} hour(s) (${keepHours / 24} day(s))`
        : `${keepHours} hour(s)`
      : "";

  const keepStr =
    keepHours > 0
      ? ` Kept ${totalKept} files from the last ${timeUnitStr}.`
      : "";
  const actionStr = dryRun
    ? `Would delete ${totalDeleted} files${timeUnitStr ? ` older than ${timeUnitStr}` : ""}.`
    : `Total ImageKit files deleted: ${totalDeleted}.`;

  return `${modeStr} ${actionStr}${keepStr}`;
};

const handleDeleteRequest = async (req, res) => {
  const config = getConfig(req);

  if (config.confirm !== "YES") {
    return res.status(403).json({
      success: false,
      error:
        "Refusing to delete. Set CONFIRM_DELETE_ALL_IMAGEKIT=YES (or ?confirm=YES) in your URL query parameters or .env file to enable.",
    });
  }

  try {
    const result = await deleteAllFiles(config);
    res.json({
      success: true,
      message: result,
      options: {
        dryRun: config.dryRun,
        keepHours: config.keepHours,
        keepDays: config.keepDays,
        supabaseTable: config.supabaseTable,
      },
    });
  } catch (error) {
    console.error("Delete-all failed:", error);
    res
      .status(500)
      .json({ success: false, error: error.message || error.toString() });
  }
};

// Handle GET and POST requests on root / and /api/delete-imagekit
app.all("/api/delete-imagekit", handleDeleteRequest);
app.all("/", handleDeleteRequest);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
