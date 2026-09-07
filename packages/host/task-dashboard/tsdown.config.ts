import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-host-task-dashboard',
  ['lib/types/index.js'],
  { hostPhase: true },
)
