import { useEffect, useState } from "react";

/** Parse the location hash into a route path, e.g. "#/stacks/cas_x" -> "/stacks/cas_x". */
export function currentHashRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash.length === 0 ? "/" : hash;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function useHashRoute(): string {
  const [route, setRoute] = useState(currentHashRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentHashRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export interface RouteMatch {
  readonly pattern: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Match a route path against a pattern with `:param` segments. */
export function matchRoute(pattern: string, path: string): RouteMatch | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const segment = patternParts[i]!;
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(pathParts[i]!);
    } else if (segment !== pathParts[i]) {
      return null;
    }
  }
  return { pattern, params };
}
