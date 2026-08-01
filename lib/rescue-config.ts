// Revenue Rescue public-site configuration.
// Pricing is hardcoded here for now; it becomes admin-editable with the subscriptions task.

export type RescuePlan = {
  id: string;
  name: string;
  price: number;
  cadence: "per month" | "one-time";
  blurb: string;
  features: string[];
  featured?: boolean;
};

export const rescuePlans: RescuePlan[] = [
  {
    id: "core",
    name: "Revenue Rescue Core",
    price: 997,
    cadence: "per month",
    blurb: "The essential reactivation system for a single pipeline.",
    features: [
      "Up to 2,500 stored leads",
      "Monthly lead imports",
      "Lead cleanup and deduplication",
      "AI analysis and scoring",
      "Email campaign preparation",
      "Revenue dashboard",
      "One CRM or webhook connection",
      "Three users",
    ],
  },
  {
    id: "pro",
    name: "Revenue Rescue Pro",
    price: 1497,
    cadence: "per month",
    blurb: "Multi-channel outreach with reply handling and CRM sync.",
    featured: true,
    features: [
      "Up to 10,000 stored leads",
      "SMS and email campaigns",
      "Reply classification",
      "Appointment routing",
      "Five users",
      "CRM synchronization",
      "Monthly performance reporting",
    ],
  },
  {
    id: "complete",
    name: "Complete Revenue Engine",
    price: 2497,
    cadence: "per month",
    blurb: "The full MogulForge growth stack around Revenue Rescue.",
    features: [
      "Revenue Rescue",
      "AI Front Desk",
      "Lead CRM",
      "Voice and SMS",
      "Email automation",
      "Appointment scheduling",
      "Review automation",
      "Lead attribution",
      "Advanced reporting",
    ],
  },
  {
    id: "sprint",
    name: "Revenue Rescue Sprint",
    price: 3500,
    cadence: "one-time",
    blurb: "The initial cleanup, analysis, and reactivation service for your existing lead database.",
    features: [
      "Full lead-database import and cleanup",
      "Deduplication and suppression handling",
      "AI scoring of every dormant opportunity",
      "Personalized reactivation campaigns prepared",
      "Recovered-pipeline report",
    ],
  },
];

export const pricingFactors = [
  "Lead volume",
  "Data quality",
  "Messaging volume",
  "CRM complexity",
  "Number of integrations",
  "Number of users",
  "Outreach channels",
  "White-label requirements",
];

// Illustrative metrics for the landing-page dashboard preview. Always shown with an
// explicit "Example data" label — these are not live or client numbers.
export const exampleMetrics = [
  { label: "Dormant leads imported", value: "1,248" },
  { label: "Leads analyzed", value: "1,106" },
  { label: "High-potential opportunities", value: "186" },
  { label: "Conversations restarted", value: "42" },
  { label: "Appointments booked", value: "17" },
  { label: "Potential recovered pipeline", value: "$284,000" },
];

// Default assumptions for the revenue calculator (rates are fractions).
export const calculatorDefaults = {
  dormantLeads: 1000,
  averageProjectValue: 12000,
  reactivationRate: 0.08,
  bookingRate: 0.4,
  closeRate: 0.3,
};
