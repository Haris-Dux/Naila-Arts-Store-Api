import { RegisteredSection } from './section-definition';
import { announcementBarSection } from './announcement-bar.section';
import { homeBannerSliderSection } from './home-banner.section';

/**
 * Every editable region of the storefront.
 *
 * To add one: write a DTO and a `defineSection(...)` next to these, then add it
 * to this array. Nothing else changes — no migration, no route, no service
 * method. The list order is the order the admin panel shows them in.
 */
export const SECTION_REGISTRY: readonly RegisteredSection[] = [
  announcementBarSection,
  homeBannerSliderSection,
];
