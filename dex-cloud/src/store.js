import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const now = () => Date.now();

const TABLES = [
  "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, plan_tier TEXT NOT NULL, plan_status TEXT NOT NULL, plan_expires_at INTEGER, plan_version INTEGER NOT NULL DEFAULT 1, auto_cloud INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, account_id TEXT, name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS device_codes (code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, account_id TEXT, device_name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, redeemed_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS email_attempts (attempt_hash TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL, user_code TEXT, checkout_id TEXT, device_name TEXT, platform TEXT, app_version TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS control_sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS installations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_instance_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT, app_version TEXT, kind TEXT NOT NULL DEFAULT 'desktop', created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS installation_credentials (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS pair_requests (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, account_id TEXT NOT NULL, device_name TEXT NOT NULL, status TEXT NOT NULL, link TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, answered_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS clouds (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, team_id TEXT, name TEXT NOT NULL, color TEXT, tier TEXT, status TEXT NOT NULL, origin TEXT, role TEXT NOT NULL, power_state TEXT NOT NULL DEFAULT 'awake', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, cancelled_at INTEGER, kept INTEGER NOT NULL DEFAULT 0, removable INTEGER NOT NULL DEFAULT 1, setup INTEGER NOT NULL DEFAULT 0, hostname TEXT, machine_id TEXT, bootstrap_secret TEXT, setup_step TEXT, setup_progress REAL, last_seen_at INTEGER, version TEXT, disk_gb INTEGER, max_disk_gb INTEGER, container_id TEXT)",
  "CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_account_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, account_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (team_id, account_id))",
  "CREATE TABLE IF NOT EXISTS checkouts (id TEXT PRIMARY KEY, account_id TEXT, plan TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS consents (account_id TEXT PRIMARY KEY, status TEXT NOT NULL, text_version TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS bug_reports (id TEXT PRIMARY KEY, install_id TEXT NOT NULL, source TEXT NOT NULL, description TEXT NOT NULL, app_version TEXT, platform TEXT, diagnostics TEXT, contact_email TEXT, status TEXT NOT NULL DEFAULT 'received', fixed_in TEXT, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS bug_reports_install ON bug_reports(install_id, created_at)",
  "CREATE INDEX IF NOT EXISTS sessions_token ON sessions(token_hash)",
  "CREATE INDEX IF NOT EXISTS control_sessions_token ON control_sessions(token_hash)",
  "CREATE INDEX IF NOT EXISTS installations_account ON installations(account_id)",
  "CREATE INDEX IF NOT EXISTS installation_credentials_token ON installation_credentials(token_hash)",
  "CREATE INDEX IF NOT EXISTS email_attempts_email ON email_attempts(email, created_at)",
  "CREATE INDEX IF NOT EXISTS clouds_account ON clouds(account_id)",
  "CREATE INDEX IF NOT EXISTS pair_requests_installation ON pair_requests(installation_id, created_at)",
];

const SESSION_BY_TOKEN = [
  "SELECT s.*, a.email AS account_email, a.plan_tier, a.plan_status, a.plan_expires_at,",
  "d.name AS device_name, d.platform, d.app_version",
  "FROM sessions s JOIN accounts a ON a.id = s.account_id JOIN devices d ON d.id = s.device_id",
  "WHERE s.token_hash = ? AND s.revoked_at IS NULL",
].join(" ");

const INSTALLATION_BY_TOKEN = [
  "SELECT c.*, i.account_id, i.client_instance_id, i.name, i.platform, i.app_version, i.kind,",
  "i.created_at AS installation_created_at",
  "FROM installation_credentials c JOIN installations i ON i.id = c.installation_id",
  "WHERE c.token_hash = ? AND c.revoked_at IS NULL",
].join(" ");

const CONTROL_SESSION_BY_TOKEN = [
  "SELECT s.*, a.email FROM control_sessions s JOIN accounts a ON a.id = s.account_id",
  "WHERE s.token_hash = ? AND s.revoked_at IS NULL",
].join(" ");

const TEAMS_FOR = [
  "SELECT t.*, m.role FROM teams t JOIN team_members m ON m.team_id = t.id",
  "WHERE m.account_id = ? ORDER BY t.created_at ASC",
].join(" ");

const MIGRATIONS = [
  "ALTER TABLE accounts ADD COLUMN auto_cloud INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE clouds ADD COLUMN hostname TEXT",
  "ALTER TABLE clouds ADD COLUMN machine_id TEXT",
  "ALTER TABLE clouds ADD COLUMN bootstrap_secret TEXT",
  "ALTER TABLE clouds ADD COLUMN setup_step TEXT",
  "ALTER TABLE clouds ADD COLUMN setup_progress REAL",
  "ALTER TABLE clouds ADD COLUMN last_seen_at INTEGER",
  "ALTER TABLE clouds ADD COLUMN version TEXT",
  "ALTER TABLE clouds ADD COLUMN disk_gb INTEGER",
  "ALTER TABLE clouds ADD COLUMN max_disk_gb INTEGER",
  "ALTER TABLE clouds ADD COLUMN container_id TEXT",
  // A computer's relay identity outlives every token: paired phones pin it.
  "ALTER TABLE installations ADD COLUMN relay_host_id TEXT",
];

const CLOUD_UPDATES = {
  name: "UPDATE clouds SET name = ?, updated_at = ? WHERE id = ?",
  color: "UPDATE clouds SET color = ?, updated_at = ? WHERE id = ?",
  tier: "UPDATE clouds SET tier = ?, updated_at = ? WHERE id = ?",
  status: "UPDATE clouds SET status = ?, updated_at = ? WHERE id = ?",
  origin: "UPDATE clouds SET origin = ?, updated_at = ? WHERE id = ?",
  power_state: "UPDATE clouds SET power_state = ?, updated_at = ? WHERE id = ?",
  expires_at: "UPDATE clouds SET expires_at = ?, updated_at = ? WHERE id = ?",
  cancelled_at: "UPDATE clouds SET cancelled_at = ?, updated_at = ? WHERE id = ?",
  kept: "UPDATE clouds SET kept = ?, updated_at = ? WHERE id = ?",
  removable: "UPDATE clouds SET removable = ?, updated_at = ? WHERE id = ?",
  setup: "UPDATE clouds SET setup = ?, updated_at = ? WHERE id = ?",
  hostname: "UPDATE clouds SET hostname = ?, updated_at = ? WHERE id = ?",
  machine_id: "UPDATE clouds SET machine_id = ?, updated_at = ? WHERE id = ?",
  bootstrap_secret: "UPDATE clouds SET bootstrap_secret = ?, updated_at = ? WHERE id = ?",
  setup_step: "UPDATE clouds SET setup_step = ?, updated_at = ? WHERE id = ?",
  setup_progress: "UPDATE clouds SET setup_progress = ?, updated_at = ? WHERE id = ?",
  last_seen_at: "UPDATE clouds SET last_seen_at = ?, updated_at = ? WHERE id = ?",
  version: "UPDATE clouds SET version = ?, updated_at = ? WHERE id = ?",
  disk_gb: "UPDATE clouds SET disk_gb = ?, updated_at = ? WHERE id = ?",
  max_disk_gb: "UPDATE clouds SET max_disk_gb = ?, updated_at = ? WHERE id = ?",
  container_id: "UPDATE clouds SET container_id = ?, updated_at = ? WHERE id = ?",
};

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  for (const statement of TABLES) db.prepare(statement).run();
  for (const statement of MIGRATIONS) {
    try {
      db.prepare(statement).run();
    } catch (error) {
      if (!/duplicate column name/i.test(String(error?.message ?? ""))) throw error;
    }
  }
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  accountById(id) {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) ?? null;
  }

  accountByEmail(email) {
    return this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) ?? null;
  }

  insertAccount({ id, email, planTier, planStatus, planExpiresAt }) {
    this.db.prepare("INSERT INTO accounts (id, email, created_at, plan_tier, plan_status, plan_expires_at, plan_version) VALUES (?, ?, ?, ?, ?, ?, 1)")
      .run(id, email, now(), planTier, planStatus, planExpiresAt ?? null);
    return this.accountById(id);
  }

  claimAutoCloud(accountId) {
    const result = this.db.prepare("UPDATE accounts SET auto_cloud = 1 WHERE id = ? AND auto_cloud = 0").run(accountId);
    return Number(result?.changes ?? 0) === 1;
  }

  updatePlan(accountId, { tier, status, expiresAt }) {
    this.db.prepare("UPDATE accounts SET plan_tier = ?, plan_status = ?, plan_expires_at = ?, plan_version = plan_version + 1 WHERE id = ?")
      .run(tier, status, expiresAt ?? null, accountId);
  }

  insertDevice({ id, accountId = null, name, platform, appVersion }) {
    const created = now();
    this.db.prepare("INSERT INTO devices (id, account_id, name, platform, app_version, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, accountId, name, platform, appVersion, created, created);
    return this.device(id);
  }

  device(id) {
    return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) ?? null;
  }

  attachDevice(deviceId, accountId) {
    this.db.prepare("UPDATE devices SET account_id = ?, last_seen_at = ? WHERE id = ?").run(accountId, now(), deviceId);
  }

  touchDevice(deviceId) {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), deviceId);
  }

  insertSession({ id, accountId, deviceId, tokenHash, expiresAt }) {
    this.db.prepare("INSERT INTO sessions (id, account_id, device_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, accountId, deviceId, tokenHash, now(), expiresAt);
  }

  sessionByTokenHash(tokenHash) {
    return this.db.prepare(SESSION_BY_TOKEN).get(tokenHash) ?? null;
  }

  revokeSession(tokenHash) {
    this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(now(), tokenHash);
  }

  insertDeviceCode({ codeHash, userCode, deviceName, platform, appVersion, expiresAt }) {
    this.db.prepare("INSERT INTO device_codes (code_hash, user_code, device_name, platform, app_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(codeHash, userCode, deviceName, platform, appVersion, now(), expiresAt);
  }

  deviceCodeByHash(codeHash) {
    return this.db.prepare("SELECT * FROM device_codes WHERE code_hash = ?").get(codeHash) ?? null;
  }

  deviceCodeByUserCode(userCode) {
    return this.db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get(userCode) ?? null;
  }

  approveDeviceCode(codeHash, accountId) {
    this.db.prepare("UPDATE device_codes SET account_id = ?, approved_at = ? WHERE code_hash = ? AND approved_at IS NULL")
      .run(accountId, now(), codeHash);
  }

  redeemDeviceCode(codeHash) {
    this.db.prepare("UPDATE device_codes SET redeemed_at = ? WHERE code_hash = ?").run(now(), codeHash);
  }

  purgeDeviceCodes(before) {
    this.db.prepare("DELETE FROM device_codes WHERE expires_at < ?").run(before);
  }

  insertEmailAttempt({ attemptHash, email, codeHash, purpose, userCode = null, checkoutId = null, deviceName = null, platform = null, appVersion = null, expiresAt }) {
    this.db.prepare([
      "INSERT INTO email_attempts",
      "(attempt_hash, email, code_hash, purpose, user_code, checkout_id, device_name, platform, app_version, created_at, expires_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" ")).run(attemptHash, email, codeHash, purpose, userCode, checkoutId, deviceName, platform, appVersion, now(), expiresAt);
  }

  emailAttempt(attemptHash) {
    return this.db.prepare("SELECT * FROM email_attempts WHERE attempt_hash = ?").get(attemptHash) ?? null;
  }

  latestEmailAttempt(email, purpose) {
    return this.db.prepare(
      "SELECT * FROM email_attempts WHERE email = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).get(email, purpose) ?? null;
  }

  countEmailAttempts(email, since) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM email_attempts WHERE email = ? AND created_at >= ?").get(email, since);
    return Number(row?.count ?? 0);
  }

  recordEmailFailure(attemptHash) {
    this.db.prepare("UPDATE email_attempts SET attempts = attempts + 1 WHERE attempt_hash = ?").run(attemptHash);
  }

  consumeEmailAttempt(attemptHash) {
    this.db.prepare("UPDATE email_attempts SET consumed_at = ? WHERE attempt_hash = ?").run(now(), attemptHash);
  }

  purgeEmailAttempts(before) {
    this.db.prepare("DELETE FROM email_attempts WHERE expires_at < ?").run(before);
  }

  insertControlSession({ id, accountId, tokenHash, expiresAt }) {
    this.db.prepare("INSERT INTO control_sessions (id, account_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, accountId, tokenHash, now(), expiresAt);
  }

  controlSessionByTokenHash(tokenHash) {
    return this.db.prepare(CONTROL_SESSION_BY_TOKEN).get(tokenHash) ?? null;
  }

  revokeControlSession(tokenHash) {
    this.db.prepare("UPDATE control_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(now(), tokenHash);
  }

  insertInstallation({ id, accountId, clientInstanceId, name, platform, appVersion, kind }) {
    const created = now();
    this.db.prepare([
      "INSERT INTO installations (id, account_id, client_instance_id, name, platform, app_version, kind, created_at, last_seen_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" ")).run(id, accountId, clientInstanceId, name, platform ?? null, appVersion ?? null, kind, created, created);
    return this.installation(id);
  }

  installation(id) {
    return this.db.prepare("SELECT * FROM installations WHERE id = ?").get(id) ?? null;
  }

  installationByClientInstance(accountId, clientInstanceId) {
    return this.db.prepare("SELECT * FROM installations WHERE account_id = ? AND client_instance_id = ?").get(accountId, clientInstanceId) ?? null;
  }

  installationsFor(accountId) {
    return this.db.prepare("SELECT * FROM installations WHERE account_id = ? ORDER BY created_at ASC").all(accountId);
  }

  touchInstallation(id) {
    this.db.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?").run(now(), id);
  }

  /**
   * Refreshes what a signed-in device reports about itself, and marks it seen.
   *
   * The name and the version move with the device — a rename or an upgrade
   * should not need a fresh registration, which would rotate the credential a
   * desktop is still polling with.
   */
  updateInstallationProfile(id, { name, platform = null, appVersion = null }) {
    this.db.prepare([
      "UPDATE installations SET name = ?, platform = COALESCE(?, platform),",
      "app_version = COALESCE(?, app_version), last_seen_at = ? WHERE id = ?",
    ].join(" ")).run(name, platform, appVersion, now(), id);
  }

  /**
   * A desktop's relay-token refresh doubles as its heartbeat: keep the row's
   * view of the app current so the account page shows what actually runs, not
   * what registered. The version only moves forward on what the client
   * reported — an absent report leaves the stored one alone.
   */
  installationSeen(id, appVersion = null) {
    this.db.prepare("UPDATE installations SET app_version = COALESCE(?, app_version), last_seen_at = ? WHERE id = ?")
      .run(appVersion, now(), id);
  }

  /**
   * Drops phone rows that stopped reporting.
   *
   * Only `kind = 'phone'` qualifies: a desktop row may be pinned by a paired
   * phone's stored relay identity, and deleting it would leave that phone
   * knocking on a name the relay no longer has (4404) while both ends are
   * online. Phones carry no installation credential worth keeping — they
   * authenticate with the account session — so the row and its pending
   * requests go together.
   */
  purgeStalePhones(before) {
    const stale = this.db.prepare("SELECT id FROM installations WHERE kind = 'phone' AND last_seen_at < ?").all(before);
    if (!stale.length) return 0;
    this.transaction(() => {
      for (const { id } of stale) {
        this.db.prepare("UPDATE installation_credentials SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL").run(now(), id);
        this.db.prepare("DELETE FROM pair_requests WHERE installation_id = ?").run(id);
        this.db.prepare("DELETE FROM installations WHERE id = ?").run(id);
      }
    });
    return stale.length;
  }

  /**
   * The relay identity of one installation, made once and kept.
   *
   * A phone pins `h` from the descriptor it paired with, and its stored
   * connection keeps dialling that name forever. A hostId that changed per
   * token refresh would leave every paired phone knocking on an identity the
   * relay no longer has — it answers 4404, and the phone shows the computer as
   * unreachable while both ends are online.
   */
  relayHostId(installationId, mint) {
    const read = () => this.db.prepare("SELECT relay_host_id FROM installations WHERE id = ?").get(installationId)?.relay_host_id ?? null;
    const existing = read();
    if (existing) return existing;
    // `AND relay_host_id IS NULL` settles a race between two first requests.
    this.db.prepare("UPDATE installations SET relay_host_id = ? WHERE id = ? AND relay_host_id IS NULL")
      .run(mint(), installationId);
    return read();
  }

  deleteInstallation(accountId, id) {
    this.transaction(() => {
      this.db.prepare("UPDATE installation_credentials SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL").run(now(), id);
      this.db.prepare("DELETE FROM installations WHERE id = ? AND account_id = ?").run(id, accountId);
    });
  }

  insertInstallationCredential({ id, installationId, tokenHash, expiresAt }) {
    this.db.prepare("INSERT INTO installation_credentials (id, installation_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, installationId, tokenHash, now(), expiresAt);
  }

  installationCredentialByTokenHash(tokenHash) {
    return this.db.prepare(INSTALLATION_BY_TOKEN).get(tokenHash) ?? null;
  }

  revokeInstallationCredentials(installationId) {
    this.db.prepare("UPDATE installation_credentials SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL").run(now(), installationId);
  }

  insertPairRequest({ id, installationId, accountId, deviceName, expiresAt }) {
    this.db.prepare("INSERT INTO pair_requests (id, installation_id, account_id, device_name, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, installationId, accountId, deviceName, now(), expiresAt);
  }

  pairRequest(id) {
    return this.db.prepare("SELECT * FROM pair_requests WHERE id = ?").get(id) ?? null;
  }

  /** Pending requests this computer has not answered, newest last. */
  pendingPairRequests(installationId, at = now()) {
    return this.db.prepare("SELECT * FROM pair_requests WHERE installation_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at ASC")
      .all(installationId, at);
  }

  /** How many the account asked of this computer since `since`, for the per-installation cap. */
  pairRequestCount(installationId, since) {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pair_requests WHERE installation_id = ? AND created_at > ?").get(installationId, since);
    return Number(row?.n ?? 0);
  }

  answerPairRequest(id, { status, link = null }) {
    this.db.prepare("UPDATE pair_requests SET status = ?, link = ?, answered_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, link, now(), id);
  }

  /** Expire what was never answered; called before a read so a stale row cannot be approved late. */
  expirePairRequests(at = now()) {
    this.db.prepare("UPDATE pair_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(at);
  }

  cloudsFor(accountId) {
    return this.db.prepare("SELECT * FROM clouds WHERE account_id = ? ORDER BY created_at ASC").all(accountId);
  }

  cloud(id) {
    return this.db.prepare("SELECT * FROM clouds WHERE id = ?").get(id) ?? null;
  }

  cloudByHostname(hostname) {
    return this.db.prepare("SELECT * FROM clouds WHERE hostname = ?").get(String(hostname).toLowerCase()) ?? null;
  }

  liveClouds() {
    return this.db.prepare("SELECT * FROM clouds WHERE status IN ('setting_up','ready','offline')").all();
  }

  deleteCloud(id) {
    this.db.prepare("DELETE FROM clouds WHERE id = ?").run(id);
  }

  insertCloud({ id, accountId, teamId = null, name, color = null, tier = null, status, origin = null, role, hostname = null, machineId = null, bootstrapSecret = null, diskGb = null, maxDiskGb = null }) {
    const created = now();
    this.db.prepare([
      "INSERT INTO clouds (id, account_id, team_id, name, color, tier, status, origin, role, created_at, updated_at, removable, setup, hostname, machine_id, bootstrap_secret, disk_gb, max_disk_gb)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)",
    ].join(" ")).run(id, accountId, teamId, name, color, tier, status, origin, role, created, created, hostname, machineId, bootstrapSecret, diskGb, maxDiskGb);
    return this.cloud(id);
  }

  updateCloud(id, fields) {
    const stamp = now();
    for (const [field, statement] of Object.entries(CLOUD_UPDATES)) {
      if (fields[field] !== undefined) this.db.prepare(statement).run(fields[field], stamp, id);
    }
    return this.cloud(id);
  }

  hideCloud(id) {
    this.db.prepare("UPDATE clouds SET status = 'ended', removable = 1, updated_at = ? WHERE id = ?").run(now(), id);
  }

  teamsFor(accountId) {
    return this.db.prepare(TEAMS_FOR).all(accountId);
  }

  insertCheckout({ id, accountId = null, plan, source, expiresAt }) {
    this.db.prepare("INSERT INTO checkouts (id, account_id, plan, source, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'open', ?, ?)")
      .run(id, accountId, plan, source, now(), expiresAt);
    return this.checkout(id);
  }

  checkout(id) {
    return this.db.prepare("SELECT * FROM checkouts WHERE id = ?").get(id) ?? null;
  }

  completeCheckout(id, accountId) {
    this.db.prepare("UPDATE checkouts SET status = 'complete', account_id = ?, completed_at = ? WHERE id = ?").run(accountId, now(), id);
  }

  consent(accountId) {
    return this.db.prepare("SELECT * FROM consents WHERE account_id = ?").get(accountId) ?? null;
  }

  setConsent(accountId, status, textVersion) {
    this.db.prepare([
      "INSERT INTO consents (account_id, status, text_version, updated_at) VALUES (?, ?, ?, ?)",
      "ON CONFLICT(account_id) DO UPDATE SET status = excluded.status, text_version = excluded.text_version, updated_at = excluded.updated_at",
    ].join(" ")).run(accountId, status, textVersion, now());
    return this.consent(accountId);
  }

  insertBugReport({ id, installId, source, description, appVersion = null, platform = null, diagnostics = null, contactEmail = null }) {
    this.db.prepare([
      "INSERT INTO bug_reports (id, install_id, source, description, app_version, platform, diagnostics, contact_email, status, created_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)",
    ].join(" ")).run(id, installId, source, description, appVersion, platform, diagnostics, contactEmail, now());
    return this.bugReport(id);
  }

  bugReport(id) {
    return this.db.prepare("SELECT * FROM bug_reports WHERE id = ?").get(id) ?? null;
  }

  /** The status of `ids` as sent by this install: an id another install sent is unknown here. */
  bugReportStatuses(installId, ids) {
    const statement = this.db.prepare("SELECT id, status, fixed_in FROM bug_reports WHERE id = ? AND install_id = ?");
    return ids.map((id) => statement.get(id, installId) ?? { id, status: "unknown", fixed_in: null });
  }

  recentBugReports(limit = 100) {
    return this.db.prepare("SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  markBugReportFixed(id, fixedIn) {
    this.db.prepare("UPDATE bug_reports SET status = 'fixed', fixed_in = ? WHERE id = ?").run(fixedIn, id);
    return this.bugReport(id);
  }

  counts() {
    const accounts = this.db.prepare("SELECT COUNT(*) AS count FROM accounts").get();
    const installations = this.db.prepare("SELECT COUNT(*) AS count FROM installations").get();
    const clouds = this.db.prepare("SELECT COUNT(*) AS count FROM clouds").get();
    return {
      accounts: Number(accounts?.count ?? 0),
      installations: Number(installations?.count ?? 0),
      clouds: Number(clouds?.count ?? 0),
    };
  }
}
