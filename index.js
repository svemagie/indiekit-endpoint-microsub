import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  importBookmarkAsFollow,
  updateBookmarkFollow,
} from "./lib/bookmark-import.js";
import { microsubController } from "./lib/controllers/microsub.js";
import { opmlController } from "./lib/controllers/opml.js";
import { readerController } from "./lib/controllers/reader.js";
import { handleMediaProxy } from "./lib/media/proxy.js";
import { startScheduler, stopScheduler } from "./lib/polling/scheduler.js";
import { ensureActivityPubChannel } from "./lib/storage/channels.js";
import {
  cleanupAllReadItems,
  cleanupStaleItems,
  createIndexes,
} from "./lib/storage/items.js";
import { getUserId } from "./lib/utils/auth.js";
import { webmentionReceiver } from "./lib/webmention/receiver.js";
import { websubHandler } from "./lib/websub/handler.js";

const defaults = {
  mountPath: "/microsub",
};
const router = express.Router();
const readerRouter = express.Router();

const bookmarkHookRouter = express.Router();
bookmarkHookRouter.use((request, response, next) => {
  response.on("finish", () => {
    if (request.method !== "POST") return;

    const action =
      request.query?.action || request.body?.action || "create";
    const { application } = request.app.locals;
    const userId = getUserId(request);

    // ── CREATE: new bookmark post ────────────────────────────────────────────
    if (
      action === "create" &&
      (response.statusCode === 201 || response.statusCode === 202)
    ) {
      const bookmarkOf =
        request.body?.["bookmark-of"] ||
        request.body?.properties?.["bookmark-of"]?.[0];
      if (!bookmarkOf) return;

      // Collect all tags (all micropub body formats)
      const rawCategory =
        request.body?.category ||
        request.body?.properties?.category;
      const tags = Array.isArray(rawCategory)
        ? rawCategory.filter(Boolean)
        : rawCategory
        ? [rawCategory]
        : [];

      // The post permalink may appear in the Location response header
      const postUrl = response.getHeader?.("Location") || undefined;

      importBookmarkAsFollow(application, bookmarkOf, tags, userId, postUrl).catch(
        (err) =>
          console.warn("[Microsub] bookmark-import failed:", err.message),
      );
      return;
    }

    // ── UPDATE: bookmark post edited ─────────────────────────────────────────
    if (
      action === "update" &&
      (response.statusCode === 200 ||
        response.statusCode === 204)
    ) {
      const postUrl = request.body?.url;
      if (!postUrl) return;

      // Detect what changed
      const replace = request.body?.replace || {};
      const deleteFields = request.body?.delete || [];
      const deleteList = Array.isArray(deleteFields)
        ? deleteFields
        : Object.keys(deleteFields);

      // bookmark-of removed?
      const bookmarkRemoved =
        deleteList.includes("bookmark-of") ||
        (replace["bookmark-of"] !== undefined &&
          !replace["bookmark-of"]?.[0]);

      // New tags?
      const rawNewTags =
        replace.category ||
        replace?.properties?.category;
      const newTags = rawNewTags
        ? Array.isArray(rawNewTags)
          ? rawNewTags.filter(Boolean)
          : [rawNewTags]
        : null;

      if (bookmarkRemoved || newTags) {
        updateBookmarkFollow(
          application,
          postUrl,
          { bookmarkRemoved: !!bookmarkRemoved, newTags: newTags || undefined },
          userId,
        ).catch((err) =>
          console.warn("[Microsub] bookmark-update failed:", err.message),
        );
      }
      return;
    }
  });

  next();
});

export default class MicrosubEndpoint {
  name = "Microsub endpoint";

  /**
   * @param {object} options - Plugin options
   * @param {string} [options.mountPath] - Path to mount Microsub endpoint
   */
  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.mountPath = this.options.mountPath;
  }

  /**
   * Locales directory path
   * @returns {string} Path to locales directory
   */
  get localesDirectory() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
  }

  /**
   * Navigation items for Indiekit admin
   * @returns {object} Navigation item configuration
   */
  get navigationItems() {
    return {
      href: path.join(this.options.mountPath, "reader"),
      text: "microsub.reader.title",
      requiresDatabase: true,
    };
  }

  /**
   * Shortcut items for quick actions
   * @returns {object} Shortcut item configuration
   */
  get shortcutItems() {
    return {
      url: path.join(this.options.mountPath, "reader", "channels"),
      name: "microsub.channels.title",
      iconName: "feed",
      requiresDatabase: true,
    };
  }

  /**
   * Middleware hook registered on the Micropub route to intercept bookmark
   * posts and auto-follow them as Microsub feed subscriptions.
   * @returns {import("express").Router} Express router
   */
  get contentNegotiationRoutes() {
    return bookmarkHookRouter;
  }

  /**
   * Microsub API and reader UI routes (authenticated)
   * @returns {import("express").Router} Express router
   */
  get routes() {
    // Main Microsub endpoint - dispatches based on action parameter
    router.get("/", microsubController.get);
    router.post("/", microsubController.post);

    // WebSub callback endpoint
    router.get("/websub/:id", websubHandler.verify);
    router.post("/websub/:id", websubHandler.receive);

    // Webmention receiving endpoint
    router.post("/webmention", webmentionReceiver.receive);

    // Media proxy endpoint
    router.get("/media/:hash", handleMediaProxy);

    // Reader UI routes (mounted as sub-router for correct baseUrl)
    readerRouter.get("/", readerController.index);
    readerRouter.get("/channels", readerController.channels);
    readerRouter.get("/channels/new", readerController.newChannel);
    readerRouter.post("/channels/new", readerController.createChannel);
    readerRouter.get("/channels/:uid", readerController.channel);
    readerRouter.get("/channels/:uid/settings", readerController.settings);
    readerRouter.post(
      "/channels/:uid/settings",
      readerController.updateSettings,
    );
    readerRouter.post("/channels/:uid/delete", readerController.deleteChannel);
    readerRouter.get("/channels/:uid/feeds", readerController.feeds);
    readerRouter.post("/channels/:uid/feeds", readerController.addFeed);
    readerRouter.post(
      "/channels/:uid/feeds/remove",
      readerController.removeFeed,
    );
    readerRouter.get(
      "/channels/:uid/feeds/:feedId",
      readerController.feedDetails,
    );
    readerRouter.get(
      "/channels/:uid/feeds/:feedId/edit",
      readerController.editFeedForm,
    );
    readerRouter.post(
      "/channels/:uid/feeds/:feedId/edit",
      readerController.updateFeedUrl,
    );
    readerRouter.post(
      "/channels/:uid/feeds/:feedId/rediscover",
      readerController.rediscoverFeed,
    );
    readerRouter.post(
      "/channels/:uid/feeds/:feedId/refresh",
      readerController.refreshFeed,
    );
    readerRouter.get("/item/:id", readerController.item);
    readerRouter.get("/compose", readerController.compose);
    readerRouter.post("/compose", readerController.submitCompose);
    readerRouter.get("/search", readerController.searchPage);
    readerRouter.post("/search", readerController.searchFeeds);
    readerRouter.post("/subscribe", readerController.subscribe);
    readerRouter.get("/actor", readerController.actorProfile);
    readerRouter.post("/actor/follow", readerController.followActorAction);
    readerRouter.post("/actor/unfollow", readerController.unfollowActorAction);
    readerRouter.post("/api/mark-read", readerController.markAllRead);
    readerRouter.get("/opml", opmlController.exportOpml);
    readerRouter.get("/timeline", readerController.timeline);
    readerRouter.get("/deck", readerController.deck);
    readerRouter.get("/deck/settings", readerController.deckSettings);
    readerRouter.post("/deck/settings", readerController.saveDeckSettings);
    router.use("/reader", readerRouter);

    return router;
  }

  /**
   * Public routes (no authentication required)
   * @returns {import("express").Router} Express router
   */
  get routesPublic() {
    const publicRouter = express.Router();

    // WebSub verification must be public for hubs to verify
    publicRouter.get("/websub/:id", websubHandler.verify);
    publicRouter.post("/websub/:id", websubHandler.receive);

    // Webmention endpoint must be public
    publicRouter.post("/webmention", webmentionReceiver.receive);

    // Media proxy must be public for images to load
    publicRouter.get("/media/:hash", handleMediaProxy);

    return publicRouter;
  }

  /**
   * Initialize plugin
   * @param {object} indiekit - Indiekit instance
   */
  init(indiekit) {
    console.info("[Microsub] Initializing endpoint-microsub plugin");

    // Register MongoDB collections
    indiekit.addCollection("microsub_channels");
    indiekit.addCollection("microsub_feeds");
    indiekit.addCollection("microsub_items");
    indiekit.addCollection("microsub_notifications");
    indiekit.addCollection("microsub_muted");
    indiekit.addCollection("microsub_blocked");
    indiekit.addCollection("microsub_deck_config");

    console.info("[Microsub] Registered MongoDB collections");

    // Register endpoint
    indiekit.addEndpoint(this);

    // Set microsub endpoint URL in config
    if (!indiekit.config.application.microsubEndpoint) {
      indiekit.config.application.microsubEndpoint = this.mountPath;
    }

    // Start feed polling scheduler when server starts
    // This will be called after the server is ready
    if (indiekit.database) {
      console.info("[Microsub] Database available, starting scheduler");
      startScheduler(indiekit);

      // Ensure system channels exist
      ensureActivityPubChannel(indiekit).catch((error) => {
        console.warn(
          "[Microsub] ActivityPub channel creation failed:",
          error.message,
        );
      });

      // Create indexes for optimal performance (runs in background)
      createIndexes(indiekit).catch((error) => {
        console.warn("[Microsub] Index creation failed:", error.message);
      });

      // Cleanup old read items on startup
      cleanupAllReadItems(indiekit).catch((error) => {
        console.warn("[Microsub] Startup cleanup failed:", error.message);
      });

      // Delete stale items (stripped skeletons + unread older than 30 days)
      cleanupStaleItems(indiekit).catch((error) => {
        console.warn("[Microsub] Stale cleanup failed:", error.message);
      });
    } else {
      console.warn(
        "[Microsub] Database not available at init, scheduler not started",
      );
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy() {
    stopScheduler();
  }
}
