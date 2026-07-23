declare const __MOZI_VERSION__: string | undefined;
declare const __MOZI_COMMIT__: string | undefined;
declare const __MOZI_BUILD_TIME__: string | undefined;
declare const __MOZI_CHANNEL__: string | undefined;

export type BuildSurface = 'desktop' | 'docker' | 'source';
export type ReleaseChannel = 'stable' | 'beta' | 'dev';

export interface BuildInfo {
  version: string;
  commit: string;
  buildTime: string;
  channel: ReleaseChannel;
  surface: BuildSurface;
}

function embedded(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function releaseChannel(value: string): ReleaseChannel {
  return value === 'stable' || value === 'beta' ? value : 'dev';
}

export function detectBuildSurface(env: NodeJS.ProcessEnv = process.env): BuildSurface {
  if (env.MOZI_DESKTOP === '1') return 'desktop';
  if (env.MOZI_BUILD_SURFACE === 'docker' || env.MOZI_HOME === '/data') return 'docker';
  return 'source';
}

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    version: embedded(typeof __MOZI_VERSION__ === 'undefined' ? undefined : __MOZI_VERSION__, '0.0.0-dev'),
    commit: embedded(typeof __MOZI_COMMIT__ === 'undefined' ? undefined : __MOZI_COMMIT__, 'unknown'),
    buildTime: embedded(typeof __MOZI_BUILD_TIME__ === 'undefined' ? undefined : __MOZI_BUILD_TIME__, 'unknown'),
    channel: releaseChannel(embedded(typeof __MOZI_CHANNEL__ === 'undefined' ? undefined : __MOZI_CHANNEL__, 'dev')),
    surface: detectBuildSurface(env),
  };
}
