import { describe, expect, it } from 'vitest';
import {
  buildServiceEnvironment,
  detectServicePlatform,
  parseLaunchctlListStatus,
  renderLinuxUnit,
  renderMacOSPlist,
  resolveServicePaths,
} from './service-install.js';

describe('runtime/service-install', () => {
  describe('detectServicePlatform', () => {
    it('maps linux', () => {
      expect(detectServicePlatform('linux')).toBe('linux');
    });
    it('maps darwin', () => {
      expect(detectServicePlatform('darwin')).toBe('darwin');
    });
    it('maps other platforms to unsupported', () => {
      expect(detectServicePlatform('win32')).toBe('unsupported');
      expect(detectServicePlatform('freebsd')).toBe('unsupported');
    });
  });

  describe('resolveServicePaths', () => {
    it('returns systemd user unit path on linux', () => {
      const paths = resolveServicePaths('/home/user', 'linux');
      expect(paths.platform).toBe('linux');
      expect(paths.unitName).toBe('mozi.service');
      expect(paths.unitPath).toBe('/home/user/.config/systemd/user/mozi.service');
    });

    it('returns LaunchAgents plist path on darwin', () => {
      const paths = resolveServicePaths('/Users/user', 'darwin');
      expect(paths.platform).toBe('darwin');
      expect(paths.unitName).toBe('ai.mozi.agent');
      expect(paths.unitPath).toBe('/Users/user/Library/LaunchAgents/ai.mozi.agent.plist');
    });

    it('returns empty unit path on unsupported platforms', () => {
      const paths = resolveServicePaths('/home/user', 'unsupported');
      expect(paths.unitPath).toBe('');
    });
  });

  describe('buildServiceEnvironment', () => {
    it('does not force default host or port over config files', () => {
      expect(buildServiceEnvironment({ HOME: '/Users/u' } as NodeJS.ProcessEnv)).toEqual({
        MOZI_HOME: '/Users/u/.mozi',
      });
    });

    it('preserves explicit host and port overrides', () => {
      expect(buildServiceEnvironment({
        MOZI_HOME: '/Users/u/Library/Application Support/MOZI',
        MOZI_SERVER_HOST: '0.0.0.0',
        MOZI_SERVER_PORT: '9444',
        MOZI_DESKTOP: '1',
        MOZI_DESKTOP_MANAGED_HOME: '1',
      } as NodeJS.ProcessEnv)).toEqual({
        MOZI_HOME: '/Users/u/Library/Application Support/MOZI',
        MOZI_SERVER_HOST: '0.0.0.0',
        MOZI_SERVER_PORT: '9444',
        MOZI_DESKTOP: '1',
        MOZI_DESKTOP_MANAGED_HOME: '1',
      });
    });
  });

  describe('parseLaunchctlListStatus', () => {
    it('marks numeric launchd PID as enabled and active', () => {
      expect(parseLaunchctlListStatus([
        'PID\tStatus\tLabel',
        '431\t0\tai.mozi.agent',
      ].join('\n'), 'ai.mozi.agent')).toEqual({ enabled: true, active: true });
    });

    it('marks loaded launchd jobs without a PID as enabled but inactive', () => {
      expect(parseLaunchctlListStatus([
        'PID\tStatus\tLabel',
        '-\t78\tai.mozi.agent',
      ].join('\n'), 'ai.mozi.agent')).toEqual({ enabled: true, active: false });
    });

    it('marks missing launchd jobs as disabled and inactive', () => {
      expect(parseLaunchctlListStatus([
        'PID\tStatus\tLabel',
        '431\t0\tcom.example.other',
      ].join('\n'), 'ai.mozi.agent')).toEqual({ enabled: false, active: false });
    });
  });

  describe('renderLinuxUnit', () => {
    it('embeds working dir, entry, and log paths', () => {
      const unit = renderLinuxUnit({
        nodePath: '/usr/bin/node',
        entryPath: '/repo/dist/index.js',
        workingDir: '/repo',
        logPath: '/home/user/.mozi/logs/mozi.log',
      });
      expect(unit).toContain('Description=MOZI Autonomous Agent Operating System');
      expect(unit).toContain('WorkingDirectory=/repo');
      expect(unit).toContain('ExecStart=/usr/bin/node /repo/dist/index.js');
      expect(unit).toContain('StandardOutput=append:/home/user/.mozi/logs/mozi.log');
      expect(unit).toContain('Restart=on-failure');
      expect(unit).toContain('WantedBy=default.target');
    });

    it('embeds runtime environment overrides', () => {
      const unit = renderLinuxUnit({
        nodePath: '/usr/bin/node',
        entryPath: '/repo/dist/index.js',
        workingDir: '/repo',
        logPath: '/home/user/.mozi/logs/mozi.log',
        env: {
          MOZI_HOME: '/Users/u/Library/Application Support/MOZI',
          MOZI_SERVER_PORT: '9210',
        },
      });
      expect(unit).toContain('Environment="MOZI_HOME=/Users/u/Library/Application Support/MOZI"');
      expect(unit).toContain('Environment="MOZI_SERVER_PORT=9210"');
    });
  });

  describe('renderMacOSPlist', () => {
    it('embeds label, program args, and paths', () => {
      const plist = renderMacOSPlist({
        label: 'ai.mozi.agent',
        nodePath: '/usr/local/bin/node',
        entryPath: '/repo/dist/index.js',
        workingDir: '/repo',
        logPath: '/Users/u/.mozi/logs/mozi.log',
        env: {
          MOZI_HOME: '/Users/u/Library/Application Support/MOZI',
          MOZI_DESKTOP: '1',
          MOZI_SERVER_HOST: '127.0.0.1',
          MOZI_SERVER_PORT: '9210',
        },
      });
      expect(plist).toContain('<string>ai.mozi.agent</string>');
      expect(plist).toContain('<string>/repo</string>');
      expect(plist).toContain('<string>/usr/local/bin/node</string>');
      expect(plist).toContain('<string>/repo/dist/index.js</string>');
      expect(plist).toContain('<string>/Users/u/.mozi/logs/mozi.log</string>');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<key>KeepAlive</key>');
      expect(plist).toContain('<key>MOZI_HOME</key>');
      expect(plist).toContain('<string>/Users/u/Library/Application Support/MOZI</string>');
      expect(plist).toContain('<key>MOZI_DESKTOP</key>');
      expect(plist).toContain('<key>MOZI_SERVER_PORT</key>');
    });

    it('escapes XML-sensitive characters', () => {
      const plist = renderMacOSPlist({
        label: 'ai.mozi.agent',
        nodePath: '/usr/bin/node',
        entryPath: '/tmp/weird & path/index.js',
        workingDir: '/tmp/weird & path',
        logPath: '/tmp/log',
      });
      expect(plist).toContain('weird &amp; path');
      expect(plist).not.toContain('weird & path');
    });
  });
});
