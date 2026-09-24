/**
 * Surfaces that reach a principal only once the Lune API releases them to it.
 *
 * The API decides per credential (`account/mcp-context`). Nothing it has not
 * confirmed is ever listed, so a failed probe, an unknown principal, and a
 * caller that never asked all see the public surface. An unreleased surface is
 * absent from every list a client reads and answers as unknown when called; a
 * call the API could not be asked about goes on to the API, which decides it.
 */
export type ReleaseName = "figures";

export type Releases = Readonly<Record<ReleaseName, boolean>>;

export const PUBLIC_RELEASES: Releases = Object.freeze({ figures: false });

export const ALL_RELEASES: Releases = Object.freeze({ figures: true });

/** An item with no release belongs to the public surface. */
export function isReleased(
  release: ReleaseName | undefined,
  releases: Releases,
): boolean {
  return release === undefined || releases[release];
}

/**
 * What one request may see and reach. The halves differ only while the API
 * cannot be asked about the credential: it is shown the public surface, and a
 * call to a released tool goes on to the API, whose own gate decides it.
 */
export interface ReleaseView {
  /** Listed tools, listed and served prompts, and the instructions. */
  readonly listed: Releases;
  /** The tools a call may reach. */
  readonly callable: Releases;
}

/** Where a server reads the view for each request it answers. */
export type ReleaseSource = () => Promise<ReleaseView>;

export function answeredView(releases: Releases): ReleaseView {
  return Object.freeze({ listed: releases, callable: releases });
}

/** The API released nothing, or the caller never asked it. */
export const PUBLIC_VIEW: ReleaseView = answeredView(PUBLIC_RELEASES);

/** The API could not be asked, and nothing it said before still stands. */
export const UNANSWERED_VIEW: ReleaseView = Object.freeze({
  listed: PUBLIC_RELEASES,
  callable: ALL_RELEASES,
});

export function fixedReleases(view: ReleaseView): ReleaseSource {
  return () => Promise.resolve(view);
}
