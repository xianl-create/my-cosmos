# One-off patch: longer wizard task strings. Run: python3 scripts/patch-wiz-tasks.py
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "js" / "app.js"
s = path.read_text(encoding="utf-8")

NEW_DEFAULT = """const WIZ_DEFAULT_COMMON_TASKS=[
  'Block 90 minutes to finish the one project that is due this week',
  'Email your manager a short status update before 4pm today',
  'Schedule a dentist cleaning in the next 30 days and put it on the calendar',
  'Pay the two overdue household bills online and save the confirmation PDFs',
  'Walk 8,000 steps after lunch and log how your knees felt',
  'Declutter the junk drawer and donate anything unused for 12 months',
  'Call your sibling for 20 minutes just to catch up (no agenda)',
  'Back up your laptop photos to an external drive before bed tonight',
  'Review next week\'s calendar and cancel one low-value meeting',
  'Write three concrete goals for Monday morning and pin them where you will see them'
];"""


def arr(*items):
    parts = []
    for it in items:
        parts.append("'" + it.replace("\\", "\\\\").replace("'", "\\'") + "'")
    return "[" + ",".join(parts) + "]"


CATS = {}
CATS["work"] = [
    "Clear your inbox to under 20 messages before lunch and archive newsletters you never read",
    "Write a half-page brief on yesterday's customer issue and post it in the team channel by 3pm",
    "Schedule a 25-minute 1:1 with your report to unblock the dashboard redesign before Friday",
    "Update the roadmap slide deck with shipped items from this sprint and send the link to stakeholders",
    "Record a 3-minute Loom walking through the new feature flag so support can answer tickets",
    "Block two hours of deep work with Slack in Do Not Disturb to finish the spec reviewers asked for",
    "Reply to the vendor contract redlines with bullet decisions by end of day Tuesday",
    "Groom the backlog: close stale tickets, re-estimate three epics, and assign owners for next sprint",
    "Prepare five talking points for tomorrow’s standup about risks to the launch date",
    "Export last month’s time-tracking CSV and attach it to the finance email they requested",
]
CATS["shopping"] = [
    "Amazon return the shoes by Tuesday 6pm at the Whole Foods locker before the window closes",
    "Compare dishwasher models using Consumer Reports and price-match at the store with a printed page",
    "Buy a birthday gift online with guaranteed Thursday delivery and wrap it Sunday while you watch a show",
    "Schedule curbside grocery pickup Saturday at 10am before the good slots disappear Friday night",
    "Return ill-fitting jeans with the receipt in the bag pocket because the mall closes early Sundays",
    "Research extended warranty only if repair-cost history suggests it beats self-insuring",
    "Clip digital coupons in the store app before checkout Sunday because the cashier cannot retroapply",
    "Photograph serial numbers of new electronics for your insurance rider before you toss the boxes",
    "Buy a replacement vacuum filter now because last time you waited until dust triggered allergies",
    "Make a shopping list from your meal plan and stick to the perimeter aisles for your health budget",
]

keys_order = [
    "work", "life", "health", "home", "family", "learning", "fun", "growth", "money", "creativity",
    "community", "well-being", "sports", "travel", "entertainment", "fitness", "career", "friends",
    "rest", "food", "music", "reading", "art", "nature", "projects", "hobbies", "social", "spirituality",
    "movies", "comedy", "shows", "exercise", "study", "school", "research", "deadlines", "homework",
    "meetings", "email", "coding", "writing", "gaming", "cooking", "pets", "garden", "budget",
    "side projects", "meditation", "sleep", "chores", "planning", "photography", "volunteering",
    "shopping", "commute", "journaling", "podcasts", "news", "dating", "parenting", "household",
    "errands", "appointments", "therapy", "networking", "training", "grading", "applications",
]

# For keys not fully hand-authored above, generate longer, specific-sounding lines (unique per index).
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "next Monday"]
TIMES = ["9am", "11am", "1pm", "4pm", "6pm", "7:30pm", "before noon", "after dinner"]


def longify(cat: str, i: int) -> str:
    label = "Side projects" if cat == "side projects" else ("Well-being" if cat == "well-being" else cat.replace("-", " ").title())
    day = DAYS[i % len(DAYS)]
    tm = TIMES[(i * 3 + len(cat)) % len(TIMES)]
    frames = [
        f"Before {day} at {tm}, pick one {label} task you keep postponing and do only the first 12 minutes with a timer",
        f"Add a calendar event on {day} titled ‘{label}: deep block’ and silence notifications for the full 45 minutes",
        f"Write three bullet outcomes you want from {label} this week, circle the smallest one, and finish it before {day} night",
        f"Text or email one person who can unblock a {label} item for you, with a specific ask and a suggested {day} time window",
        f"Spend 20 minutes {day} evening tidying the physical or digital space where {label} work happens, then stop on time",
        f"Open notes, write the very next action for {label} (verb + object + tool), and schedule it for {tm} on {day}",
        f"Set a phone reminder for {day} that says ‘{label}: 25m sprint’ and delete one distracting app shortcut beforehand",
        f"Before {day}, gather receipts/links/docs for one {label} admin task so you are not searching frantically at the deadline",
        f"Pick a realistic ‘good enough’ bar for one {label} deliverable due soon and ship a draft before {tm} on {day}",
        f"After {label} work on {day}, log one sentence: what worked, what to tweak next time—keep it under 20 words",
        f"Block {day} morning for {label}: no new inputs—only close loops you already started (email threads, half-done forms)",
        f"Choose one {label} habit to repeat three times before next Sunday and track checkmarks on paper where you will see them",
    ]
    return frames[i % len(frames)]


lines = ["const WIZ_COMMON_TASKS_BY_CATEGORY={"]
for k in keys_order:
    keyname = "'well-being'" if k == "well-being" else ("'side projects'" if k == "side projects" else repr(k))
    if k in CATS:
        val = CATS[k]
    else:
        val = [longify(k, i) for i in range(10)]
    lines.append(f"  {keyname}:{arr(*val)},")
lines[-1] = lines[-1][:-1]
lines.append("};")
block_new = NEW_DEFAULT + "\n" + "\n".join(lines)

pat = re.compile(
    r"const WIZ_DEFAULT_COMMON_TASKS=\[[\s\S]*?\];\nconst WIZ_COMMON_TASKS_BY_CATEGORY=\{[\s\S]*?\n\};",
    re.M,
)
m = pat.search(s)
if not m:
    raise SystemExit("pattern not found")
path.write_text(pat.sub(block_new, s, count=1), encoding="utf-8")
print("patched", path)
