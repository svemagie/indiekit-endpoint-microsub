/**
 * Bookmark-to-microsub import
 *
 * When a Micropub bookmark-of post is created, automatically follow that URL
 * as a feed in the Microsub reader.
 *
 * Flow: bookmark created → find/create channel from tag → create feed →
 *       notify blogroll (which gets its entry from microsub, not independently).
 *
 * @module bookmark-import
 */

import { detectCapabilities } from "./feeds/capabilities.js";
import {
  discoverAndValidateFeeds,
  getBestFeed,
} from "./feeds/discovery.js";
import { refreshFeedNow } from "./polling/scheduler.js";
import { createChannel, getChannels } from "./storage/channels.js";
import {
  createFeed,
  deleteFeedById,
  findFeedAcrossChannels,
  getFeedByMicropubPostUrl,
  updateFeed,
} from "./storage/feeds.js";
import { notifyBlogroll } from "./utils/blogroll-notify.js";

const BOOKMARKS_CHANNEL_NAME = "Bookmarks";
const SYSTEM_CHANNELS = new Set(["notifications", "activitypub"]);

/**
 * Resolve (find or create) a Microsub channel by name.
 * Uses exact case-insensitive match; creates a new channel if none found.
 *
 * @param {object} application - Indiekit application context
 * @param {string} channelName - Desired channel name
 * @param {string} userId - User ID
 * @returns {Promise<object>} Full channel document (with _id)
 */
async function resolveChannel(application, channelName, userId) {
  const channelsCollection = application.collections.get("microsub_channels");
  const nameLower = channelName.toLowerCase();

  // Try to find existing channel (full documents needed for _id)
  const channels = await channelsCollection
    .find(userId ? { userId } : {})
    .sort({ order: 1 })
    .toArray();

  const existing = channels.find(
    (ch) => ch.name?.toLowerCase() === nameLower,
  );
  if (existing) return existing;

  // Create new channel
  const created = await createChannel(application, { name: channelName, userId });

  // createChannel returns the document from collection but may not have _id if
  // it was returned before insertOne; fetch it back to be safe.
  const fresh = await channelsCollection.findOne(
    userId ? { uid: created.uid, userId } : { uid: created.uid },
  );
  return fresh || created;
}

/**
 * Follow a bookmarked URL as a Microsub feed subscription.
 *
 * - Uses the FIRST tag as the channel name (creates the channel if needed).
 * - Falls back to "Bookmarks" channel if no tag is given.
 * - If the feed already exists in a DIFFERENT channel, move it.
 * - Notifies the blogroll plugin after creating/moving the feed.
 * - Stores micropubPostUrl on the feed for future update/delete tracking.
 *
 * @param {object} application - Indiekit application context
 * @param {string|string[]} bookmarkUrl - The bookmarked URL
 * @param {string|string[]} [tags=[]] - Micropub category/tags for channel selection
 * @param {string} [userId="default"] - User ID for channel lookup
 * @param {string} [postUrl] - Permalink of the micropub post (for tracking)
 */
export async function importBookmarkAsFollow(
  application,
  bookmarkUrl,
  tags = [],
  userId = "default",
  postUrl,
) {
  const url = Array.isArray(bookmarkUrl) ? bookmarkUrl[0] : bookmarkUrl;

  try {
    new URL(url);
  } catch {
    console.warn(`[Microsub] bookmark-import: invalid URL: ${url}`);
    return { error: `Invalid bookmark URL: ${url}` };
  }

  if (!application.collections?.has("microsub_channels")) {
    console.warn(
      "[Microsub] bookmark-import: microsub collections not available",
    );
    return { error: "microsub not initialised" };
  }

  // Discover the actual feed URL — skip import if no valid feed exists
  const discoveredFeeds = await discoverAndValidateFeeds(url).catch(() => []);
  const bestFeed = getBestFeed(discoveredFeeds);
  if (!bestFeed) {
    console.log(
      `[Microsub] bookmark-import: no feed found at ${url}, skipping`,
    );
    return { skipped: true, reason: "no feed found", url };
  }
  const feedUrl = bestFeed.url;

  // Normalise tags to an array of trimmed, non-empty strings
  const tagList = (Array.isArray(tags) ? tags : [tags])
    .map((t) => String(t).trim())
    .filter(Boolean);

  // Desired channel: first tag or "Bookmarks" fallback
  const desiredChannelName =
    tagList[0] ||
    BOOKMARKS_CHANNEL_NAME;

  // Resolve (find or create) the target channel
  const targetChannel = await resolveChannel(
    application,
    desiredChannelName,
    userId,
  );

  if (!targetChannel) {
    console.warn("[Microsub] bookmark-import: could not resolve channel");
    return { error: "could not resolve channel" };
  }

  // Check if already followed in any channel
  const existing = await findFeedAcrossChannels(application, feedUrl);

  if (existing) {
    const existingFeed = existing.feed;
    const existingChannelName = existing.channelName;

    // If in the correct channel already, nothing to do
    if (
      existingFeed.channelId.toString() === targetChannel._id.toString()
    ) {
      // Update micropubPostUrl if we now know it and it wasn't set
      if (postUrl && !existingFeed.micropubPostUrl) {
        await updateFeed(application, existingFeed._id, {
          micropubPostUrl: postUrl,
        });
      }
      console.log(
        `[Microsub] bookmark-import: ${feedUrl} already followed in "${existingChannelName}" (correct channel)`,
      );
      return { alreadyExists: true, url: feedUrl, channel: existingChannelName };
    }

    // Wrong channel — move the feed: delete from old channel, create in new one.
    console.log(
      `[Microsub] bookmark-import: moving ${feedUrl} from "${existingChannelName}" → "${targetChannel.name}"`,
    );
    await deleteFeedById(application, existingFeed._id);
    // Fall through to create below
  }

  // Create feed subscription in the target channel
  let feed;
  try {
    feed = await createFeed(application, {
      channelId: targetChannel._id,
      url: feedUrl,
      title: bestFeed.title || undefined,
      photo: undefined,
      micropubPostUrl: postUrl || undefined,
    });
  } catch (error) {
    if (error.code === "DUPLICATE_FEED") {
      console.log(
        `[Microsub] bookmark-import: duplicate feed detected for ${feedUrl}`,
      );
      return { alreadyExists: true, url: feedUrl };
    }
    throw error;
  }

  // Fire-and-forget: fetch and detect capabilities
  refreshFeedNow(application, feed._id).catch((error) => {
    console.error(
      `[Microsub] bookmark-import: error fetching ${feedUrl}:`,
      error.message,
    );
  });
  detectCapabilities(feedUrl).catch((error) => {
    console.error(
      `[Microsub] bookmark-import: capability detection error for ${feedUrl}:`,
      error.message,
    );
  });

  // Notify blogroll (it gets its entries from microsub, not independently)
  notifyBlogroll(application, "follow", {
    url: feedUrl,
    title: feed.title,
    channelName: targetChannel.name,
    feedId: feed._id.toString(),
    channelId: targetChannel._id.toString(),
  }).catch((error) => {
    console.error(`[Microsub] bookmark-import: blogroll notify error:`, error.message);
  });

  console.log(
    `[Microsub] bookmark-import: added ${feedUrl} (discovered from ${url}) to channel "${targetChannel.name}"`,
  );
  return { added: 1, url: feedUrl, channel: targetChannel.name };
}

/**
 * Handle a bookmark post UPDATE.
 *
 * Called when a micropub update action is detected and the post previously
 * created a feed subscription. Handles:
 *   - Tag change → move feed to new channel, update blogroll category
 *   - bookmark-of removed → unfollow from microsub and remove from blogroll
 *
 * @param {object} application - Indiekit application context
 * @param {string} postUrl - Permalink of the micropub post being updated
 * @param {object} changes - Detected changes from the micropub update body
 * @param {string[]} [changes.newTags] - New category/tag values (if changed)
 * @param {boolean} [changes.bookmarkRemoved] - True if bookmark-of was deleted
 * @param {string} [changes.newBookmarkUrl] - New bookmark-of URL (if changed)
 * @param {string} [userId="default"] - User ID
 */
export async function updateBookmarkFollow(
  application,
  postUrl,
  changes,
  userId = "default",
) {
  if (!application.collections?.has("microsub_channels")) return;

  // Find the feed that was created from this post
  const existing = await getFeedByMicropubPostUrl(application, postUrl);
  if (!existing) {
    console.log(
      `[Microsub] bookmark-update: no feed found for post ${postUrl}`,
    );
    return;
  }

  const { feed, channel } = existing;

  // Case 1: bookmark-of removed or post type changed → unfollow
  if (changes.bookmarkRemoved) {
    console.log(
      `[Microsub] bookmark-update: bookmark-of removed for ${postUrl}, unfollowing ${feed.url}`,
    );
    await deleteFeedById(application, feed._id);
    notifyBlogroll(application, "unfollow", { url: feed.url }).catch(
      (error) => {
        console.error(
          `[Microsub] bookmark-update: blogroll notify error:`,
          error.message,
        );
      },
    );
    return;
  }

  // Case 2: tag/category changed → move feed to new channel
  if (changes.newTags && changes.newTags.length > 0) {
    const desiredChannelName = changes.newTags[0];

    // Already in the right channel?
    if (channel?.name?.toLowerCase() === desiredChannelName.toLowerCase()) {
      console.log(
        `[Microsub] bookmark-update: channel unchanged for ${feed.url}`,
      );
      return;
    }

    const newChannel = await resolveChannel(
      application,
      desiredChannelName,
      userId,
    );

    // Move: delete from old, create in new
    console.log(
      `[Microsub] bookmark-update: moving ${feed.url} → channel "${newChannel.name}"`,
    );
    await deleteFeedById(application, feed._id);

    let newFeed;
    try {
      newFeed = await createFeed(application, {
        channelId: newChannel._id,
        url: feed.url,
        title: feed.title,
        photo: feed.photo,
        micropubPostUrl: postUrl,
      });
    } catch (error) {
      if (error.code !== "DUPLICATE_FEED") throw error;
      // If it ended up there already, that's fine
      return;
    }

    // Refresh the feed in its new home
    refreshFeedNow(application, newFeed._id).catch(() => {});

    // Update blogroll category
    notifyBlogroll(application, "follow", {
      url: newFeed.url,
      title: newFeed.title,
      channelName: newChannel.name,
      feedId: newFeed._id.toString(),
      channelId: newChannel._id.toString(),
    }).catch((error) => {
      console.error(
        `[Microsub] bookmark-update: blogroll notify error:`,
        error.message,
      );
    });
  }
}
