# Core

- Canonical source: /home/ubuntu/rental-manager-v2; cloud ops for Hygglo accounts leo + dbcinema with shared inventory/calendar.
- Main surfaces: Next.js UI in src/app and src/components; Convex schema/functions in convex; Trigger jobs in src/trigger; Hygglo transport/domain logic in src/hygglo-core.
- Confirmed rentals drive calendar entries; pickup/return wall-clock logic uses Europe/London.
- Dashboard figures must share canonical data sources; prefer indexed, bounded Convex reads and materialized small widget rows for frequent reactive reads.
- Automated renter-message dispatch remains disabled; manual Quick Reply is an operator action. Inspect current runtime/settings guards before changing any outbound path.
- Current deployment/provider state is volatile; verify live Convex, Trigger, Vercel deployment and production alias rather than inferring from a successful local command.
- Stack and version pins: `mem:tech_stack`. Project commands: `mem:suggested_commands`. Code patterns: `mem:conventions`. Completion gates: `mem:task_completion`.