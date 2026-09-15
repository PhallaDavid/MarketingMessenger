import express from "express";
import "dotenv/config";
import ImageKit from "imagekit";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts configuration from query parameters, request body, or falls back to process.env
 */
const getConfig = (req) => {
  const query = req.query || {};
  const body = req.body || {};

  const publicKey =
    query.IMAGEKIT_PUBLIC_KEY ||
    query.publicKey ||
    body.IMAGEKIT_PUBLIC_KEY ||
    body.publicKey ||
    process.env.IMAGEKIT_PUBLIC_KEY ||
    "public_dummy_key";

  const privateKey =
    query.IMAGEKIT_PRIVATE_KEY ||
    query.privateKey ||
    body.IMAGEKIT_PRIVATE_KEY ||
    body.privateKey ||
    process.env.IMAGEKIT_PRIVATE_KEY;

  const urlEndpoint =
    query.IMAGEKIT_URL_ENDPOINT ||
    query.urlEndpoint ||
    body.IMAGEKIT_URL_ENDPOINT ||
    body.urlEndpoint ||
    process.env.IMAGEKIT_URL_ENDPOINT;

  const supabaseUrl =
    query.SUPABASE_URL ||
    query.supabaseUrl ||
    body.SUPABASE_URL ||
    body.supabaseUrl ||
    process.env.SUPABASE_URL;

  const supabaseKey =
    query.SUPABASE_SERVICE_ROLE_KEY ||
    query.supabaseServiceRoleKey ||
    query.supabaseKey ||
    body.SUPABASE_SERVICE_ROLE_KEY ||
    body.supabaseServiceRoleKey ||
    body.supabaseKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  const supabaseTable =
    query.SUPABASE_TABLE ||
    query.supabaseTable ||
    body.SUPABASE_TABLE ||
    body.supabaseTable ||
    process.env.SUPABASE_TABLE ||
    "imagekits";

  const confirmRaw =
    query.CONFIRM_DELETE_ALL_IMAGEKIT ||
    query.confirm ||
    body.CONFIRM_DELETE_ALL_IMAGEKIT ||
    body.confirm ||
    process.env.CONFIRM_DELETE_ALL_IMAGEKIT;

  const dryRunRaw =
    query.IMAGEKIT_DELETE_DRY_RUN ??
    query.dryRun ??
    body.IMAGEKIT_DELETE_DRY_RUN ??
    body.dryRun ??
    process.env.IMAGEKIT_DELETE_DRY_RUN;

  const dryRun =
    dryRunRaw === "1" ||
    dryRunRaw === "true" ||
    dryRunRaw === true;

  const confirm =
    typeof confirmRaw === "string" ? confirmRaw.trim().toUpperCase() : confirmRaw;

  return {
    publicKey,
    privateKey,
    urlEndpoint,
    supabaseUrl,
    supabaseKey,
    supabaseTable,
    confirm,
    dryRun,
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
  await imagekit.bulkDeleteFiles(fileIds);
  console.log(`[ImageKit] Deleted ${fileIds.length} files.`);
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
  } = config;

  if (!privateKey || !urlEndpoint) {
    throw new Error(
      "Missing ImageKit credentials. Please provide IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT via URL query parameters, body payload, or .env file."
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
  let offset = 0;

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

    const fileIds = files.map((f) => f.fileId).filter(Boolean);

    for (let i = 0; i < fileIds.length; i += DELETE_BATCH) {
      const chunk = fileIds.slice(i, i + DELETE_BATCH);
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

    offset += PAGE_SIZE;
  }

  // Reset total_uploaded counter in Supabase after files are processed
  if (!dryRun && totalDeleted > 0 && supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { error } = await supabase
        .from(supabaseTable)
        .update({ total_uploaded: 0 })
        .eq("id", 15)
        .select();

      if (error) {
        console.error("[Supabase] Update error:", error.message);
      } else {
        console.log("[Supabase] Reset total_uploaded to 0.");
      }
    } catch (err) {
      console.error("[Supabase] Supabase update skipped/failed:", err.message);
    }
  }

  return dryRun
    ? `Dry run complete. Found ${totalDeleted} files in ImageKit. No files were deleted.`
    : `All done. Total ImageKit files deleted: ${totalDeleted}.`;
};

const handleDeleteRequest = async (req, res) => {
  const config = getConfig(req);

  if (config.confirm !== "YES") {
    return res.status(403).json({
      success: false,
      error:
        "Refusing to delete. Set CONFIRM_DELETE_ALL_IMAGEKIT=YES (or ?confirm=YES) in your URL parameters, body, or .env file to enable.",
    });
  }

  try {
    const result = await deleteAllFiles(config);
    res.json({
      success: true,
      message: result,
      options: {
        dryRun: config.dryRun,
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
