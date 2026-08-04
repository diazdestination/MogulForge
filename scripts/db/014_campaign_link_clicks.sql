-- Campaign booking-link click tracking (task 118)
-- One row per (campaign, lead) pair — the primary key deduplicates concurrent
-- or repeat page loads so a lead counts at most once per campaign.
-- Only tokens that carry both a campaign claim (cmp) AND a lead claim are
-- tracked; org-wide links without a lead are not counted here.

CREATE TABLE IF NOT EXISTS rescue_campaign_clicks (
  organization_id  uuid        NOT NULL,
  campaign_id      uuid        NOT NULL REFERENCES rescue_campaigns (id) ON DELETE CASCADE,
  lead_id          uuid        NOT NULL REFERENCES rescue_leads  (id) ON DELETE CASCADE,
  clicked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, lead_id)
);

CREATE INDEX IF NOT EXISTS rescue_campaign_clicks_org_campaign
  ON rescue_campaign_clicks (organization_id, campaign_id);
