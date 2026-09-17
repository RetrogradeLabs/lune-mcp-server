import runtimeDefaults from "./runtime-defaults.json";

export function runtimeSetting(
  name: string,
  developmentFallback: string,
): string {
  const value = process.env[name]?.trim();

  if (value) return value;

  if (process.env.NODE_ENV === "production") {
    throw new Error(`Missing required production configuration: ${name}`);
  }

  return developmentFallback;
}

export function runtimeSiteUrl(path: `/${string}`): string {
  const siteOrigin = runtimeSetting(
    "LUNE_SITE_ORIGIN",
    runtimeDefaults.site_origin,
  );

  const parsed = new URL(siteOrigin);

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "LUNE_SITE_ORIGIN must be an HTTPS origin without credentials or a path",
    );
  }

  return new URL(path, parsed.origin).href;
}
