// Social actions that other layers (ActivityPub delivery, cross-posting) react to. The social core calls these
// after its own work is done, so it never needs to know who's listening.

import type { Facet, PublicLink, User } from '@getjolt/protocol';
import type { PostRow } from '../db/schema.js';

export interface SocialHooks {
  /** Resolves `@user@server` mentions to known users (fetching remote actors if needed). */
  resolveMentions?(facets: Facet[]): Promise<Facet[]>;
  /** The browser address for a post; remote posts link to their home server. */
  postUrl?(post: PostRow, author: User): string | null;
  /** The browser address for a profile; remote profiles link to their home server. */
  profileUrl?(user: User): Promise<string | null>;
  /** Called before showing a remote profile, so its recent posts can be fetched. */
  beforeRemoteProfile?(userId: string): Promise<void>;
  /** Finds or fetches a post from another server by its URL and returns its local id. */
  lookupPost?(url: string): Promise<string | null>;
  /** Finds or fetches a remote account by address or URL and returns its local user id. */
  lookupActor?(address: string): Promise<string | null>;
  /** Linked Bluesky/Mastodon accounts shown on someone's profile. */
  publicLinks?(userId: string): Promise<PublicLink[]>;
  onPostCreated?(post: PostRow, options: { crosspost: string[] }): Promise<void>;
  onPostDeleted?(post: PostRow): Promise<void>;
  onRemoteFollow?(followerId: string, followeeId: string): Promise<void>;
  onRemoteUnfollow?(followerId: string, followeeId: string): Promise<void>;
  onLike?(userId: string, post: PostRow): Promise<void>;
  onUnlike?(userId: string, post: PostRow): Promise<void>;
  onRepost?(userId: string, repostId: string, post: PostRow): Promise<void>;
  onUnrepost?(userId: string, repostId: string, post: PostRow): Promise<void>;
  onProfileUpdated?(userId: string): Promise<void>;
}
