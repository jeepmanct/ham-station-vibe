import { db } from './db';

/** Public site URL used for the "Live spots: ..." link in alert emails/pushes. Unset by default (no env value baked into the repo) -- links are omitted rather than pointing somewhere wrong. */
export function getSiteUrl(): string | null {
  const url = process.env.SITE_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

export type EmailConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  alertTo: string;
  enabled: boolean;
};

export type NtfyConfig = {
  topic: string;
  enabled: boolean;
};

type Row = {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass: string | null;
  alert_to: string | null;
  enabled: number;
  ntfy_topic: string | null;
  ntfy_enabled: number;
  vhf_enabled: number;
  flare_enabled: number;
  wind_enabled: number;
  dx_us_spotters_only: number;
  vhf_us_spotters_only: number;
  kp_enabled: number;
  tropo_enabled: number;
};

function getRow(): Row | null {
  return db
    .query(
      'SELECT smtp_host, smtp_port, smtp_user, smtp_pass, alert_to, enabled, ntfy_topic, ntfy_enabled, vhf_enabled, flare_enabled, wind_enabled, dx_us_spotters_only, vhf_us_spotters_only, kp_enabled, tropo_enabled FROM alert_email_config WHERE id = 1',
    )
    .get() as Row | null;
}

/** Full config including the plaintext SMTP password — internal use only (sendAlertEmail/sendNtfyAlert), never returned by an API route. */
export function getAlertConfig(): {
  email: EmailConfig | null;
  ntfy: NtfyConfig | null;
  vhfEnabled: boolean;
  flareEnabled: boolean;
  windEnabled: boolean;
  dxUsSpottersOnly: boolean;
  vhfUsSpottersOnly: boolean;
  kpEnabled: boolean;
  tropoEnabled: boolean;
} {
  const row = getRow();
  const email =
    row?.smtp_host && row.smtp_user && row.smtp_pass && row.alert_to
      ? {
          smtpHost: row.smtp_host,
          smtpPort: row.smtp_port ?? 587,
          smtpUser: row.smtp_user,
          smtpPass: row.smtp_pass,
          alertTo: row.alert_to,
          enabled: row.enabled === 1,
        }
      : null;
  const ntfy = row?.ntfy_topic ? { topic: row.ntfy_topic, enabled: row.ntfy_enabled === 1 } : null;
  return {
    email,
    ntfy,
    vhfEnabled: row?.vhf_enabled === 1,
    flareEnabled: row?.flare_enabled === 1,
    windEnabled: row?.wind_enabled === 1,
    kpEnabled: row?.kp_enabled === 1,
    tropoEnabled: row?.tropo_enabled === 1,
    // Both default true when no config row exists yet at all, unlike the
    // other flags above -- these are meant to be on out of the box, not
    // opted into (see db.ts's migration comment for why).
    dxUsSpottersOnly: row ? row.dx_us_spotters_only === 1 : true,
    vhfUsSpottersOnly: row ? row.vhf_us_spotters_only === 1 : true,
  };
}

/** Everything except the SMTP password, safe to return from an API route as-is. */
export function getAlertConfigPublic() {
  const row = getRow();
  return {
    email: {
      smtpHost: row?.smtp_host ?? '',
      smtpPort: row?.smtp_port ?? 587,
      smtpUser: row?.smtp_user ?? '',
      alertTo: row?.alert_to ?? '',
      enabled: row?.enabled === 1,
      passwordConfigured: !!row?.smtp_pass,
    },
    ntfy: {
      topic: row?.ntfy_topic ?? '',
      enabled: row?.ntfy_enabled === 1,
    },
    vhfEnabled: row?.vhf_enabled === 1,
    flareEnabled: row?.flare_enabled === 1,
    windEnabled: row?.wind_enabled === 1,
    kpEnabled: row?.kp_enabled === 1,
    tropoEnabled: row?.tropo_enabled === 1,
    dxUsSpottersOnly: row ? row.dx_us_spotters_only === 1 : true,
    vhfUsSpottersOnly: row ? row.vhf_us_spotters_only === 1 : true,
  };
}

/**
 * Upserts config. email/ntfy are optional and independent (pass only the
 * one(s) being saved; omitting email.smtpPass keeps whatever password is
 * already stored). vhfEnabled is a separate trigger, not a channel -- it
 * doesn't gate email/ntfy's own enabled flags, just whether the VHF-opening
 * checker runs at all; when it does, it reuses whichever channels are
 * already enabled.
 */
export function setAlertConfig(cfg: {
  email?: Omit<EmailConfig, 'smtpPass'> & { smtpPass?: string };
  ntfy?: NtfyConfig;
  vhfEnabled?: boolean;
  flareEnabled?: boolean;
  windEnabled?: boolean;
  dxUsSpottersOnly?: boolean;
  vhfUsSpottersOnly?: boolean;
  kpEnabled?: boolean;
  tropoEnabled?: boolean;
}) {
  const existing = getRow();
  const email = cfg.email;
  const ntfy = cfg.ntfy;

  const smtpHost = email ? email.smtpHost : (existing?.smtp_host ?? null);
  const smtpPort = email ? email.smtpPort : (existing?.smtp_port ?? null);
  const smtpUser = email ? email.smtpUser : (existing?.smtp_user ?? null);
  const smtpPass = email ? (email.smtpPass || existing?.smtp_pass || null) : (existing?.smtp_pass ?? null);
  const alertTo = email ? email.alertTo : (existing?.alert_to ?? null);
  const enabled = email ? (email.enabled ? 1 : 0) : (existing?.enabled ?? 0);
  const ntfyTopic = ntfy ? ntfy.topic : (existing?.ntfy_topic ?? null);
  const ntfyEnabled = ntfy ? (ntfy.enabled ? 1 : 0) : (existing?.ntfy_enabled ?? 0);
  const vhfEnabled = cfg.vhfEnabled !== undefined ? (cfg.vhfEnabled ? 1 : 0) : (existing?.vhf_enabled ?? 0);
  const flareEnabled = cfg.flareEnabled !== undefined ? (cfg.flareEnabled ? 1 : 0) : (existing?.flare_enabled ?? 0);
  const windEnabled = cfg.windEnabled !== undefined ? (cfg.windEnabled ? 1 : 0) : (existing?.wind_enabled ?? 0);
  const dxUsSpottersOnly = cfg.dxUsSpottersOnly !== undefined ? (cfg.dxUsSpottersOnly ? 1 : 0) : (existing ? existing.dx_us_spotters_only : 1);
  const vhfUsSpottersOnly = cfg.vhfUsSpottersOnly !== undefined ? (cfg.vhfUsSpottersOnly ? 1 : 0) : (existing ? existing.vhf_us_spotters_only : 1);
  const kpEnabled = cfg.kpEnabled !== undefined ? (cfg.kpEnabled ? 1 : 0) : (existing?.kp_enabled ?? 0);
  const tropoEnabled = cfg.tropoEnabled !== undefined ? (cfg.tropoEnabled ? 1 : 0) : (existing?.tropo_enabled ?? 0);

  db.query(
    `INSERT INTO alert_email_config (id, smtp_host, smtp_port, smtp_user, smtp_pass, alert_to, enabled, ntfy_topic, ntfy_enabled, vhf_enabled, flare_enabled, wind_enabled, dx_us_spotters_only, vhf_us_spotters_only, kp_enabled, tropo_enabled)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       smtp_host = excluded.smtp_host,
       smtp_port = excluded.smtp_port,
       smtp_user = excluded.smtp_user,
       smtp_pass = excluded.smtp_pass,
       alert_to = excluded.alert_to,
       enabled = excluded.enabled,
       ntfy_topic = excluded.ntfy_topic,
       ntfy_enabled = excluded.ntfy_enabled,
       vhf_enabled = excluded.vhf_enabled,
       flare_enabled = excluded.flare_enabled,
       wind_enabled = excluded.wind_enabled,
       dx_us_spotters_only = excluded.dx_us_spotters_only,
       vhf_us_spotters_only = excluded.vhf_us_spotters_only,
       kp_enabled = excluded.kp_enabled,
       tropo_enabled = excluded.tropo_enabled`,
  ).run(
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    alertTo,
    enabled,
    ntfyTopic,
    ntfyEnabled,
    vhfEnabled,
    flareEnabled,
    windEnabled,
    dxUsSpottersOnly,
    vhfUsSpottersOnly,
    kpEnabled,
    tropoEnabled,
  );
}
