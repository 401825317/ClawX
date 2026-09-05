/** A server-authored announcement shown in the managed UClaw client. */
export type ClientAnnouncementLevel = 'normal' | 'important' | 'urgent';

export type ClientAnnouncement = {
  id: string;
  title: string;
  content: string;
  level: ClientAnnouncementLevel;
  publishedAt: string;
  expiresAt?: string;
  link?: string;
};

/** Normalized, enabled announcement configuration exposed to Renderer. */
export type ClientAnnouncementConfig = {
  enabled: true;
  items: ClientAnnouncement[];
};
