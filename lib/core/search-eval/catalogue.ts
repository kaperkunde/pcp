import type { ToolCandidate } from "../search"

/**
 * A fixture catalogue for judging search's ranking (search-eval.test.ts):
 * generic kinds of servers as an owner's vault holds them, with a large
 * REST catalogue and a cloud provider's as noise. Names and descriptions
 * are invented for the fixture and name no one's own servers.
 */

type Row = [name: string, title: string | null, description: string]

function server(
  id: string,
  serverName: string,
  serverDescription: string,
  rows: Row[],
): ToolCandidate[] {
  return rows.map(([name, title, description]) => ({
    server: id,
    serverName,
    serverDescription,
    name,
    title,
    description,
    tier: "read" as const,
  }))
}

const MEDIA = server(
  "media-manager",
  "Media manager",
  "A movie library manager and torrent client: finds releases, downloads them and files them in the library.",
  [
    [
      "lookup_movie",
      "Look up a movie",
      "Search the movie database by title and return matches with their ids.",
    ],
    [
      "add_movie",
      "Add a movie",
      "Add a movie to the library and optionally start searching for a release to download.",
    ],
    ["list_movies", null, "List the movies in the library and their status."],
    [
      "get_queue",
      "Download queue",
      "List the downloads in progress, with progress and time left.",
    ],
    [
      "list_torrents",
      null,
      "List torrents in the download client with their state and ratio.",
    ],
    ["delete_movie", null, "Remove a movie from the library."],
    [
      "get_calendar",
      "Upcoming releases",
      "List movies with a release date in a range.",
    ],
  ],
)

const MAIL = server(
  "mail",
  "Mail",
  "The owner's mailbox over IMAP: read, search, send and file messages.",
  [
    [
      "list_mailboxes",
      "List mailboxes",
      "List the folders of the mail account.",
    ],
    [
      "search_messages",
      "Search messages",
      "Find messages by sender, recipient, subject, text or date in a folder.",
    ],
    ["get_message", null, "Read one message with its headers and body."],
    ["send_email", "Send an email", "Send a message from this account."],
    ["create_draft", null, "Save a draft message for later."],
    ["move_message", null, "Move a message to another folder."],
    ["delete_message", null, "Move a message to the Trash."],
  ],
)

const CALENDAR = server(
  "calendar",
  "Calendar",
  "The owner's calendars and reminders over CalDAV.",
  [
    ["list_calendars", null, "List the calendars of this account."],
    [
      "list_events",
      "List events",
      "List the events of a calendar between two dates, with time, place and attendees.",
    ],
    ["create_event", null, "Add an event to a calendar."],
    ["update_event", null, "Change an event's title, time or place."],
    ["delete_event", null, "Remove an event from a calendar."],
    ["list_reminders", null, "List the open reminders of a list."],
    ["create_reminder", null, "Add a reminder with an optional due date."],
  ],
)

const UPTIME = server(
  "uptime-monitor",
  "Uptime monitor",
  "Watches websites and services and alerts when they go down.",
  [
    [
      "list_monitors",
      "List monitors",
      "List every monitor with its current state, uptime and last check.",
    ],
    ["get_monitor", null, "Get one monitor's details and recent heartbeats."],
    ["pause_monitor", null, "Pause a monitor so it stops checking."],
    ["list_incidents", null, "List the incidents of the status page."],
  ],
)

const PAAS = server(
  "paas",
  "Self-hosted platform",
  "A self-hosted platform for deploying applications, databases and services onto servers.",
  [
    ["list_servers", null, "List the servers connected to the platform."],
    ["get_server", null, "Get one server's details and resources."],
    ["list_applications", null, "List the deployed applications."],
    ["start_application", "Start an application", "Start an application."],
    [
      "restart_application",
      "Restart an application",
      "Restart an application's containers.",
    ],
    ["get_deployment_logs", null, "Read the logs of a deployment."],
    ["list_databases", null, "List the databases the platform runs."],
    ["deploy", "Deploy", "Deploy an application or service by uuid or tag."],
  ],
)

const USAGE = server(
  "usage-reports",
  "Usage reports",
  "Read-only usage and cost reports for an AI provider's organisation.",
  [
    [
      "get_usage_report",
      "Usage report",
      "Token usage of the organisation in 1 minute, 1 hour or 1 day buckets, grouped by model or key.",
    ],
    [
      "get_cost_report",
      "Cost report",
      "Daily cost in USD of the organisation, grouped by workspace or description.",
    ],
    [
      "list_api_keys",
      null,
      "List the organisation's API keys and their state.",
    ],
  ],
)

const MESSAGING = server(
  "messaging",
  "Messaging",
  "Chat messages through a messenger account.",
  [
    [
      "send_message",
      "Send a message",
      "Send a text message to a contact or group.",
    ],
    ["list_chats", null, "List recent chats."],
    ["get_messages", null, "Read the latest messages of a chat."],
    ["list_contacts", null, "List contacts and their numbers."],
  ],
)

const SOCIAL = server(
  "social",
  "Social page",
  "Posts to the owner's page on a social network.",
  [
    [
      "create_post",
      "Create a post",
      "Publish a post with text and optional link or photo.",
    ],
    ["list_posts", null, "List recent posts and their reactions."],
    ["delete_post", null, "Delete a post."],
    ["get_insights", null, "Reach and engagement of the page over a period."],
  ],
)

const PRINTER = server("printer", "Printer", "A network printer.", [
  [
    "print_file",
    "Print a file",
    "Print a PDF or image on the printer, with copies and paper size.",
  ],
  ["list_jobs", null, "List the print queue."],
  ["cancel_job", null, "Cancel a print job."],
  ["get_status", null, "Ink levels and printer state."],
])

const SCANNER = server("scanner", "Scanner", "A document scanner.", [
  [
    "start_scan",
    "Start a scan",
    "Scan a page from the feeder or glass at a given resolution and keep it as a file.",
  ],
  ["list_scans", null, "List the scans kept."],
  ["get_scanner_status", null, "Whether the scanner is ready and has paper."],
])

const TRANSCRIBER = server("transcriber", "Transcriber", "Speech to text.", [
  [
    "transcribe",
    "Transcribe audio",
    "Turn an audio or video recording into text, with timestamps and speakers.",
  ],
  ["list_models", null, "List the speech models available."],
])

const SESSIONS = server(
  "coding-sessions",
  "Coding sessions",
  "Starts and follows coding assistant sessions on repositories.",
  [
    [
      "start_session",
      "Start a session",
      "Start a coding session on a repository with a prompt.",
    ],
    ["list_sessions", null, "List sessions and their status."],
    ["send_message", null, "Send a follow-up message to a running session."],
    ["get_session", null, "Read a session's transcript."],
  ],
)

const BANK = server("bank", "Bank", "The owner's bank accounts.", [
  [
    "list_accounts",
    "List accounts",
    "List the bank accounts with their balance.",
  ],
  ["list_payments", null, "List the payments of an account in a period."],
  ["create_payment", null, "Make a payment to an IBAN."],
  ["list_cards", null, "List the cards and their limits."],
])

const APPOINTMENTS = server(
  "appointments",
  "Appointments",
  "A booking system for customers' appointments.",
  [
    ["get_appointments", null, "List appointments in a date range."],
    [
      "post_appointments",
      null,
      "Create an appointment for a customer, a provider and a service at a start time.",
    ],
    ["get_customers", null, "List customers."],
    ["get_services", null, "List the bookable services."],
    ["delete_appointments", null, "Cancel an appointment."],
  ],
)

const SITE = server(
  "site-media",
  "Website media",
  "The media library of the owner's website.",
  [
    [
      "upload_image",
      "Upload an image",
      "Upload an image to the site's media library and return its address.",
    ],
    ["list_media", null, "List the media library."],
    ["delete_media", null, "Remove a file from the media library."],
    ["update_page", null, "Change a page's title or content."],
  ],
)

const FILES = server(
  "file-store",
  "File storage",
  "File storage: keep documents and other files for good.",
  [
    ["list_folder", null, "List a folder's files."],
    ["upload_file", null, "Upload a file to a path."],
    ["download_file", null, "Download a file by path."],
    ["delete_file", null, "Delete a file."],
  ],
)

// A large REST catalogue, as a code host's: many near neighbours.
const CODE_HOST_NAMES: Array<[string, string]> = [
  ["create_issue", "Open a new issue in a repository."],
  [
    "list_issues",
    "List issues in a repository, filtered by state, labels and assignee.",
  ],
  ["get_issue", "Get an issue with its body and labels."],
  ["update_issue", "Change an issue's title, body, state or assignees."],
  ["add_issue_comment", "Add a comment to an issue or pull request."],
  ["list_issue_comments", "List the comments on an issue."],
  ["create_pull_request", "Open a pull request from a branch."],
  ["list_pull_requests", "List pull requests in a repository."],
  ["get_pull_request", "Get a pull request with its status."],
  ["merge_pull_request", "Merge a pull request."],
  ["list_pull_request_files", "List the files a pull request changes."],
  ["create_pull_request_review", "Submit a review on a pull request."],
  ["list_commits", "List the commits of a branch."],
  ["get_commit", "Get a commit with its diff."],
  ["list_branches", "List the branches of a repository."],
  ["create_branch", "Create a branch from a commit."],
  ["get_file_contents", "Read a file or directory from a repository."],
  ["create_or_update_file", "Write a file in a repository with a commit."],
  ["delete_file", "Delete a file in a repository with a commit."],
  ["search_code", "Search code across repositories."],
  ["search_repositories", "Find repositories by name, topic or language."],
  ["search_issues", "Find issues and pull requests across repositories."],
  ["search_users", "Find users by name or email."],
  ["create_repository", "Create a repository for the user or an organisation."],
  ["fork_repository", "Fork a repository."],
  ["list_releases", "List the releases of a repository."],
  ["get_latest_release", "Get a repository's latest release."],
  ["list_tags", "List the tags of a repository."],
  [
    "list_workflow_runs",
    "List the workflow runs of a repository and their status.",
  ],
  ["get_workflow_run", "Get a workflow run's jobs and result."],
  ["run_workflow", "Trigger a workflow run."],
  ["get_job_logs", "Read the logs of a workflow job."],
  ["list_notifications", "List the user's notifications."],
  ["get_me", "Get the signed-in user's profile."],
  ["list_gists", "List the user's gists."],
  ["create_gist", "Create a gist from files."],
  ["list_teams", "List the teams of an organisation."],
  ["list_collaborators", "List who has access to a repository."],
  ["list_labels", "List the labels of a repository."],
  ["create_label", "Create a label in a repository."],
  ["list_milestones", "List the milestones of a repository."],
  [
    "list_deployments",
    "List the deployments of a repository and their status.",
  ],
  ["create_deployment_status", "Set the status of a deployment."],
  ["list_webhooks", "List a repository's webhooks."],
  [
    "get_repository_traffic",
    "Views and clones of a repository over two weeks.",
  ],
  ["list_stargazers", "List who starred a repository."],
  [
    "list_security_alerts",
    "List the dependency and code scanning alerts of a repository.",
  ],
  ["get_usage_billing", "Minutes and storage used by the account this month."],
  ["list_packages", "List the packages published by the user."],
  ["get_organization", "Get an organisation's profile."],
]

// A cloud provider's catalogue, as another large neighbour.
const CLOUD_NAMES: Array<[string, string]> = [
  [
    "list_instances",
    "List the virtual servers in the account with their state and address.",
  ],
  ["get_instance", "Get one virtual server's details."],
  ["start_instance", "Start a stopped virtual server."],
  ["stop_instance", "Stop a virtual server."],
  ["reboot_instance", "Reboot a virtual server."],
  ["create_instance", "Create a virtual server from an image and a size."],
  ["delete_instance", "Delete a virtual server."],
  ["list_volumes", "List the block storage volumes."],
  ["create_snapshot", "Take a snapshot of a volume."],
  ["list_buckets", "List the object storage buckets."],
  ["list_objects", "List the objects in a bucket."],
  ["put_object", "Upload an object to a bucket."],
  ["get_object", "Download an object from a bucket."],
  ["list_databases", "List the managed databases."],
  ["create_database_backup", "Back up a managed database."],
  ["list_dns_zones", "List the DNS zones."],
  ["list_dns_records", "List the records of a DNS zone."],
  ["create_dns_record", "Add a record to a DNS zone."],
  ["list_load_balancers", "List the load balancers and their health."],
  ["list_firewalls", "List firewalls and their rules."],
  ["create_firewall_rule", "Add a rule to a firewall."],
  ["list_certificates", "List TLS certificates and their expiry."],
  ["list_functions", "List serverless functions."],
  ["invoke_function", "Invoke a serverless function with a payload."],
  ["get_function_logs", "Read a serverless function's logs."],
  ["list_queues", "List message queues."],
  ["send_queue_message", "Send a message to a queue."],
  ["list_alarms", "List monitoring alarms and their state."],
  ["get_metric_statistics", "Statistics of a metric over a period."],
  ["list_log_groups", "List log groups."],
  ["get_billing_summary", "Charges of the account for a month, by service."],
  [
    "get_cost_forecast",
    "Forecast the account's cost for the rest of the month.",
  ],
  ["list_regions", "List the available regions."],
  ["list_images", "List machine images."],
  ["list_ssh_keys", "List the SSH keys of the account."],
  [
    "list_kubernetes_clusters",
    "List Kubernetes clusters and their node pools.",
  ],
  ["list_container_images", "List images in the container registry."],
  ["list_users", "List the account's users."],
  ["list_access_keys", "List the programmatic access keys."],
  [
    "send_email_message",
    "Send a transactional email through the email service.",
  ],
]

const noise = (
  id: string,
  name: string,
  description: string,
  list: Array<[string, string]>,
) =>
  server(
    id,
    name,
    description,
    list.map(([tool, text]): Row => [tool, null, text]),
  )

/** Every tool of the fixture, in the order a vault would list them. */
export const EVAL_TOOLS: ToolCandidate[] = [
  ...MEDIA,
  ...MAIL,
  ...CALENDAR,
  ...UPTIME,
  ...PAAS,
  ...USAGE,
  ...MESSAGING,
  ...SOCIAL,
  ...PRINTER,
  ...SCANNER,
  ...TRANSCRIBER,
  ...SESSIONS,
  ...BANK,
  ...APPOINTMENTS,
  ...SITE,
  ...FILES,
  ...noise(
    "code-host",
    "Code host",
    "Repositories, issues, pull requests and workflows of a code hosting service.",
    CODE_HOST_NAMES,
  ),
  ...noise(
    "cloud",
    "Cloud provider",
    "Servers, storage, databases, DNS and billing of a cloud provider's account.",
    CLOUD_NAMES,
  ),
]

export type EvalPhrase = {
  /** What an owner might say to an assistant. */
  phrase: string
  /**
   * Refs (server/tool) any of which is a right answer, or null for a task
   * no tool of the fixture does: reported, never scored.
   */
  expected: string[] | null
}

export const EVAL_PHRASES: EvalPhrase[] = [
  {
    phrase: "send a whatsapp to my partner",
    expected: ["messaging/send_message"],
  },
  {
    phrase: "post something on my facebook page",
    expected: ["social/create_post"],
  },
  { phrase: "print this pdf", expected: ["printer/print_file"] },
  {
    phrase: "upload a picture to my website",
    expected: ["site-media/upload_image"],
  },
  {
    phrase: "transcribe this voice memo",
    expected: ["transcriber/transcribe"],
  },
  {
    phrase: "start a coding session on my repo",
    expected: ["coding-sessions/start_session"],
  },
  {
    phrase: "how much money is in my bank accounts",
    expected: ["bank/list_accounts"],
  },
  {
    phrase: "book an appointment for a customer",
    expected: ["appointments/post_appointments"],
  },
  { phrase: "scan this paper document", expected: ["scanner/start_scan"] },
  {
    phrase: "what did I spend on claude this month",
    expected: ["usage-reports/get_cost_report"],
  },
  {
    phrase: "find a movie and download it",
    expected: ["media-manager/add_movie", "media-manager/lookup_movie"],
  },
  { phrase: "check my calendar tomorrow", expected: ["calendar/list_events"] },
  {
    phrase: "who emailed me about invoices",
    expected: ["mail/search_messages"],
  },
  {
    phrase: "check the status of my servers",
    expected: ["uptime-monitor/list_monitors", "paas/list_servers"],
  },
  { phrase: "make an image", expected: null },
]
