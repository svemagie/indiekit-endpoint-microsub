/**
 * Bookmark-to-microsub import
 *
 * When a Micropub bookmark-of post is created, automatically follow that URL
 * as a feed in the Microsub reader. Mirrors the blogroll bookmark-import pattern.
 * @module bookmark-import
 */

import { detectCapabilities } from "./feeds/capabilities.js";
import { refreshFeedNow } from "./polling/scheduler.js";
import { getChannels } from "./storage/channels.js";
import { createFeed, findFeedAcrossChannels } from "./storage/feeds.js";

const BOOKMARKS_CHANNEL_NAME = "Bookmarks";

/**
 * Follow a bookmarked URL as a Microsub feed subscription.
 *
 * Finds the best matching channel (by category name → "Bookmarks" → first
 * non-special channel) and creates a feed subscription if one does not
 * already exist.
 *
 * @param {object} application - Indiekit application context
 * @param {string|string[]} bookmarkUrl - The bookmarked URL
 * @param {string} [category="bookmarks"] - Micropub category hint for channel selection
 * @param {string} [userId="default"] - User ID for channel lookup
 */
export async function importBookmarkAsFollow(
  application,
  bookmarkUrl,
  category = "bookmarks",
  userId = "default",
) {
  const url = Array.isArray(bookmarkUrl) ? bookmarkUrl[0] : bookmarkUrl;

  try {
    new URL(url);
  } catch {
    console.warn(`[Microsub] bookmark-import: invalid URL: ${url}`);
    return { error: `Invalid bookmark URL: ${url}` };
  }

  if (!application.collections?.has("microsub_channels")) {
    console.warn("[Microsub] bookmark-import: microsub collections not available");
    return { error: "microsub not initialised" };
  }

  // Check if already followed in any channel
  const existing = await findFeedAcrossChannels(application, url);
  if (existing) {
    console.log(`[Microsub] bookmark-import: ${url} already followed`);
    return { alreadyExists: true, url };
  }

  // Find a suitable channel — category match > "Bookmarks" > first non-special
  const channels = await getChannels(application, userId);
  const categoryLower = (category || "").toLowerCase();

  const targetChannel =
    channels.find((ch) => ch.name?.toLowerCase() === categoryLower) ||
    channels.find(
      (ch) => ch.name?.toLowerCase() === BOOKMARKS_CHANNEL_NAME.toLowerCase(),
    ) ||
    channels.find(
      (ch) => ch.name !== "Notifications" && ch.name !== "ActivityPub",
    ) ||
    channels[0];

  if (!targetChannel) {
    console.warn("[Microsub] bookmark-import: no channels available");
    return { error: "no channels available" };
  }

  // Create feed subscription
  let feed;
  try {
    feed = await createFeed(application, {
      channelId: targetChannel._id,
      url,
      title: undefined,
      photo: undefined,
    });
  } catch (error) {
    if (error.code === "DUPLICATE_FEED") {
      console.log(`[Microsub] bookmark-import: feed already exists for ${url}`);
      return { alreadyExists: true, url };
    }
    throw error;
  }

  // Fire-and-forget: fetch and detect capabilities
  refreshFeedNow(application, feed._id).catch((error) => {
    console.error(
      `[Microsub] bookmark-import: error fetching ${url}:`,
      error.message,
    );
  });
  detectCapabilities(url)
    .then((_capabilities) => {
      // capabilities are stored by refreshFeedNow/processor; nothing needed here
    })
    .catch((error) => {
      console.error(
        `[Microsub] bookmark-import: capability detection error for ${url}:`,
        error.message,
      );
    });

  console.log(
    `[Microsub] bookmark-import: added ${url} to channel "${targetChannel.name}"`,
  );
  return { added: 1, url, channel: targetChannel.name };
}
