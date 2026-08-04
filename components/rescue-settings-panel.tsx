"use client";
import { useCallback, useEffect, useState } from "react";
import { CAMPAIGN_TONES } from "@/lib/rescue-engage/campaign-schema";
import type { OrgSettings } from "@/lib/org-settings-schema";

type OrgProfile = { id: string; name: string; slug: string; industry: string | null; timezone: string };
type Suppression = { id: string; channel: "email" | "phone"; value: string; reason: string | null; source: string | null; createdAt: string };

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white disabled:opacity-50";
const label = "block text-xs text-white/55";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const COMMON_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto",
];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? "AM" : "PM"}`;

export function RescueSettingsPanel({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [profile, setProfile] = useState<OrgProfile | null>(null);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [emailsText, setEmailsText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [suppressionForm, setSuppressionForm] = useState({ channel: "email" as "email" | "phone", value: "", note: "" });

  const load = useCallback(async () => {
    try {
      const [settingsRes, suppressionsRes] = await Promise.all([
        fetch(`/api/orgs/${orgId}/settings`, { cache: "no-store" }),
        fetch(`/api/orgs/${orgId}/suppressions`, { cache: "no-store" }),
      ]);
      const settingsBody = await settingsRes.json().catch(() => null);
      if (!settingsRes.ok) { setError(settingsBody?.error ?? "Could not load settings."); return; }
      setProfile(settingsBody.organization);
      setSettings(settingsBody.settings);
      setEmailsText(settingsBody.settings.notifications.notificationEmails.join(", "));
      const suppressionsBody = await suppressionsRes.json().catch(() => null);
      if (suppressionsRes.ok) setSuppressions(suppressionsBody.suppressions);
      setError("");
    } catch {
      setError("Could not load settings.");
    }
  }, [orgId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function save(patch: Record<string, unknown>, successNotice: string) {
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/settings`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not save."); return; }
      setError("");
      setNotice(successNotice);
      setProfile(body.organization);
      setSettings(body.settings);
      setEmailsText(body.settings.notifications.notificationEmails.join(", "));
    } catch {
      setError("Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function addSuppression(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/suppressions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(suppressionForm),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not add the entry."); return; }
      setError("");
      setNotice(body.alreadyListed
        ? "That contact was already on the suppression list."
        : `Added to the suppression list${body.leadsSuppressed > 0 ? ` — ${body.leadsSuppressed} matching lead${body.leadsSuppressed === 1 ? "" : "s"} suppressed` : ""}.`);
      setSuppressionForm({ channel: "email", value: "", note: "" });
      await load();
    } catch {
      setError("Could not add the entry.");
    } finally {
      setBusy(false);
    }
  }

  async function removeSuppression(record: Suppression) {
    if (!window.confirm(`Remove ${record.value} from the suppression list?\n\nLeads already suppressed stay suppressed — this only stops the value from blocking future imports.`)) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/suppressions/${record.id}`, { method: "DELETE" });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? "Could not remove the entry."); return; }
      setError("");
      setNotice(`${record.value} removed from the suppression list.`);
      await load();
    } catch {
      setError("Could not remove the entry.");
    } finally {
      setBusy(false);
    }
  }

  if (!settings || !profile) {
    return error
      ? <p className="rounded-2xl border border-forge-rust/40 bg-forge-rust/10 p-5 text-sm text-forge-rust">{error}</p>
      : <p className="text-sm text-white/50">Loading settings…</p>;
  }

  const disabled = !canManage || busy;

  return (
    <div className="space-y-6">
      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}
      {notice && <p className="rounded-xl border border-forge-lime/40 bg-forge-lime/10 px-4 py-3 text-sm text-forge-lime">{notice}</p>}
      {!canManage && <p className="text-xs text-white/45">You have read-only access to settings. Ask an owner or admin to make changes.</p>}

      {/* Organization profile */}
      <form className={box} onSubmit={(e) => {
        e.preventDefault();
        void save({
          profile: { name: profile.name, industry: profile.industry ?? "", timezone: profile.timezone },
          contact: settings.contact,
          businessHours: settings.businessHours,
        }, "Organization profile saved.");
      }}>
        <h2 className="font-display text-xl font-semibold">Organization profile</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className={label}>Company name
            <input value={profile.name} disabled={disabled} onChange={(e) => setProfile({ ...profile, name: e.target.value })} className={`${input} mt-1 block w-full`} required />
          </label>
          <label className={label}>Industry
            <input value={profile.industry ?? ""} disabled={disabled} onChange={(e) => setProfile({ ...profile, industry: e.target.value })} placeholder="e.g. Roofing" className={`${input} mt-1 block w-full`} />
          </label>
          <label className={label}>Timezone
            <input value={profile.timezone} disabled={disabled} onChange={(e) => setProfile({ ...profile, timezone: e.target.value })} list="rescue-timezones" className={`${input} mt-1 block w-full`} />
            <datalist id="rescue-timezones">{COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz} />)}</datalist>
          </label>
          <label className={label}>Contact name
            <input value={settings.contact.contactName} disabled={disabled} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, contactName: e.target.value } })} className={`${input} mt-1 block w-full`} />
          </label>
          <label className={label}>Contact email
            <input type="email" value={settings.contact.contactEmail} disabled={disabled} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, contactEmail: e.target.value } })} className={`${input} mt-1 block w-full`} />
          </label>
          <label className={label}>Contact phone
            <input value={settings.contact.contactPhone} disabled={disabled} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, contactPhone: e.target.value } })} className={`${input} mt-1 block w-full`} />
          </label>
          <label className={label}>Website
            <input value={settings.contact.website} disabled={disabled} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, website: e.target.value } })} placeholder="https://…" className={`${input} mt-1 block w-full`} />
          </label>
          <label className={`${label} sm:col-span-2`}>Business address
            <input value={settings.contact.address} disabled={disabled} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, address: e.target.value } })} className={`${input} mt-1 block w-full`} />
          </label>
        </div>
        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="text-xs font-bold uppercase tracking-wider text-white/45">Business hours</p>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <label className={label}>Open
              <input type="time" value={settings.businessHours.start} disabled={disabled} onChange={(e) => setSettings({ ...settings, businessHours: { ...settings.businessHours, start: e.target.value } })} className={`${input} mt-1 block`} />
            </label>
            <label className={label}>Close
              <input type="time" value={settings.businessHours.end} disabled={disabled} onChange={(e) => setSettings({ ...settings, businessHours: { ...settings.businessHours, end: e.target.value } })} className={`${input} mt-1 block`} />
            </label>
            <div className="flex gap-1.5">
              {DAY_LABELS.map((day, i) => {
                const active = settings.businessHours.days.includes(i);
                return (
                  <button key={day} type="button" disabled={disabled}
                    onClick={() => setSettings({
                      ...settings,
                      businessHours: {
                        ...settings.businessHours,
                        days: active ? settings.businessHours.days.filter((d) => d !== i) : [...settings.businessHours.days, i].sort((a, b) => a - b),
                      },
                    })}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition disabled:opacity-50 ${active ? "bg-forge-lime text-black" : "bg-white/5 text-white/50 hover:bg-white/10"}`}>
                    {day}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {canManage && <button type="submit" disabled={busy} className="btn-primary mt-5 px-4 py-2 text-xs disabled:opacity-40">Save profile</button>}
      </form>

      {/* Notifications */}
      <form className={box} onSubmit={(e) => {
        e.preventDefault();
        void save({
          notifications: {
            ...settings.notifications,
            notificationEmails: emailsText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
          },
        }, "Notification preferences saved.");
      }}>
        <h2 className="font-display text-xl font-semibold">Notifications</h2>
        <p className="mt-1 text-xs text-white/45">What your team gets alerted about. Delivery uses the email addresses below.</p>
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {([
            ["hotLeadAlerts", "Hot lead alerts", "When AI analysis flags a high-potential opportunity"],
            ["replyAlerts", "Reply alerts", "When a customer replies to a campaign message"],
            ["appointmentAlerts", "Appointment alerts", "When an appointment is booked or changes"],
            ["crmConnectionAlerts", "CRM connection alerts", "When a CRM connection stops working and lead delivery pauses"],
            ["customDomainAlerts", "Custom domain alerts", "When your custom domain stops resolving and visitors may be unable to reach your portal"],
            ["weeklyDigest", "Weekly digest", "A summary of pipeline movement every Monday"],
            ["planChangeReminders", "Plan change reminders", "A heads-up a few days before a scheduled downgrade takes effect"],
          ] as const).map(([key, title, sub]) => (
            <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl bg-black/30 p-3">
              <input type="checkbox" disabled={disabled} checked={settings.notifications[key]}
                onChange={(e) => setSettings({ ...settings, notifications: { ...settings.notifications, [key]: e.target.checked } })}
                className="mt-0.5 h-4 w-4 accent-[#c8f542]" />
              <span>
                <span className="block text-sm font-semibold">{title}</span>
                <span className="block text-xs text-white/45">{sub}</span>
              </span>
            </label>
          ))}
        </div>
        <label className={`${label} mt-4 block`}>Notification emails (comma-separated, up to 10)
          <input value={emailsText} disabled={disabled} onChange={(e) => setEmailsText(e.target.value)} placeholder="ops@company.com, owner@company.com" className={`${input} mt-1 block w-full`} />
        </label>
        {canManage && <button type="submit" disabled={busy} className="btn-primary mt-5 px-4 py-2 text-xs disabled:opacity-40">Save notifications</button>}
      </form>

      {/* Messaging defaults */}
      <form className={box} onSubmit={(e) => {
        e.preventDefault();
        void save({ messaging: settings.messaging }, "Messaging defaults saved.");
      }}>
        <h2 className="font-display text-xl font-semibold">Messaging defaults</h2>
        <p className="mt-1 text-xs text-white/45">Prefills for new campaigns — each campaign can still override these.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className={label}>Quiet hours start
            <select value={settings.messaging.quietHoursStart} disabled={disabled} onChange={(e) => setSettings({ ...settings, messaging: { ...settings.messaging, quietHoursStart: Number(e.target.value) } })} className={`${input} mt-1 block w-full`}>
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
          <label className={label}>Quiet hours end
            <select value={settings.messaging.quietHoursEnd} disabled={disabled} onChange={(e) => setSettings({ ...settings, messaging: { ...settings.messaging, quietHoursEnd: Number(e.target.value) } })} className={`${input} mt-1 block w-full`}>
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
          <label className={label}>Default tone
            <select value={settings.messaging.defaultTone} disabled={disabled} onChange={(e) => setSettings({ ...settings, messaging: { ...settings.messaging, defaultTone: e.target.value as OrgSettings["messaging"]["defaultTone"] } })} className={`${input} mt-1 block w-full capitalize`}>
              {CAMPAIGN_TONES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className={label}>Default sender name
            <input value={settings.messaging.defaultSenderName} disabled={disabled} onChange={(e) => setSettings({ ...settings, messaging: { ...settings.messaging, defaultSenderName: e.target.value } })} placeholder="e.g. Mike at Summit Roofing" className={`${input} mt-1 block w-full`} />
          </label>
          <label className={`${label} lg:col-span-2`}>Default booking link
            <input value={settings.messaging.defaultBookingLink} disabled={disabled} onChange={(e) => setSettings({ ...settings, messaging: { ...settings.messaging, defaultBookingLink: e.target.value } })} placeholder="https://calendly.com/…" className={`${input} mt-1 block w-full`} />
          </label>
        </div>
        <p className="mt-3 text-xs text-white/40">Quiet hours: no automated messages between {hourLabel(settings.messaging.quietHoursStart)} and {hourLabel(settings.messaging.quietHoursEnd)} (organization time).</p>
        {canManage && <button type="submit" disabled={busy} className="btn-primary mt-5 px-4 py-2 text-xs disabled:opacity-40">Save messaging defaults</button>}
      </form>

      {/* Suppression list */}
      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Suppression list</h2>
        <p className="mt-1 text-xs text-white/45">
          Contacts on this list are blocked from imports and outbound campaigns. Adding an entry also suppresses any matching existing leads.
        </p>
        {canManage && (
          <form onSubmit={addSuppression} className="mt-4 flex flex-wrap items-end gap-3 rounded-xl bg-black/30 p-4">
            <label className={label}>Type
              <select value={suppressionForm.channel} disabled={busy} onChange={(e) => setSuppressionForm({ ...suppressionForm, channel: e.target.value as "email" | "phone" })} className={`${input} mt-1 block`}>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
              </select>
            </label>
            <label className={label}>{suppressionForm.channel === "email" ? "Email address" : "Phone number"}
              <input value={suppressionForm.value} disabled={busy} required onChange={(e) => setSuppressionForm({ ...suppressionForm, value: e.target.value })}
                placeholder={suppressionForm.channel === "email" ? "person@example.com" : "(555) 123-4567"} className={`${input} mt-1 block w-56`} />
            </label>
            <label className={`${label} flex-1`}>Note
              <input value={suppressionForm.note} disabled={busy} onChange={(e) => setSuppressionForm({ ...suppressionForm, note: e.target.value })} placeholder="Optional — why is this contact blocked?" className={`${input} mt-1 block w-full`} />
            </label>
            <button type="submit" disabled={busy || !suppressionForm.value} className="btn-secondary px-4 py-2 text-xs disabled:opacity-40">Add to list</button>
          </form>
        )}
        {suppressions.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">No suppressed contacts. Opt-outs and manually blocked contacts will appear here.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-white/40">
                <tr><th className="pb-2">Contact</th><th className="pb-2">Type</th><th className="pb-2">Reason</th><th className="pb-2">Added</th>{canManage && <th className="pb-2 text-right">Actions</th>}</tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {suppressions.map((record) => (
                  <tr key={record.id}>
                    <td className="py-2.5 pr-3 font-mono text-xs">{record.value}</td>
                    <td className="py-2.5 pr-3 text-xs capitalize">{record.channel}</td>
                    <td className="py-2.5 pr-3 text-xs text-white/55">
                      <span className={`mr-2 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${record.reason === "opt_out" ? "border-forge-rust/50 text-forge-rust" : "border-white/20 text-white/50"}`}>
                        {record.reason === "opt_out" ? "Opt-out" : "Manual"}
                      </span>
                      {record.source ?? ""}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-white/50">{new Date(record.createdAt).toLocaleDateString()}</td>
                    {canManage && (
                      <td className="py-2.5 text-right">
                        <button type="button" disabled={busy} onClick={() => void removeSuppression(record)} className="text-xs font-bold text-forge-rust hover:underline disabled:opacity-40">
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
