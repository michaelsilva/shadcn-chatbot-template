/**
 * Shared between the app Worker (trigger/webhook routes) and the
 * sibling Workflow Worker (the actual `PlanExecutionWorkflow` class) —
 * both need the same Cloudflare Workflow name to map/look up instances
 * consistently (#25).
 */
export const PLAN_EXECUTION_WORKFLOW_NAME = "shadcn-chatbot-plan-execution"
