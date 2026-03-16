/**
 * Terminal progress bar for long-running fetch operations.
 */

const BAR_WIDTH = 30

export const createProgress = (label: string, total: number, startOffset = 0) => {
  const startTime = Date.now()
  let current = startOffset

  const render = () => {
    const pct = total > 0 ? Math.min(current / total, 1) : 0
    const filled = Math.round(BAR_WIDTH * pct)
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
    const pctStr = (pct * 100).toFixed(1).padStart(5)

    const elapsed = (Date.now() - startTime) / 1000
    const processed = current - startOffset
    const rate = elapsed > 0 ? processed / elapsed : 0

    let eta = ''
    if (rate > 0 && current < total) {
      const remaining = (total - current) / rate
      if (remaining < 60) eta = `${Math.ceil(remaining)}s`
      else if (remaining < 3600) eta = `${Math.ceil(remaining / 60)}m`
      else eta = `${(remaining / 3600).toFixed(1)}h`
      eta = ` ETA ${eta}`
    }

    const rateStr = rate >= 1 ? `${rate.toFixed(0)}/s` : rate > 0 ? `${(rate * 60).toFixed(1)}/m` : ''

    process.stdout.write(`\r${label} ${bar} ${pctStr}% ${current}/${total} ${rateStr}${eta}  `)
  }

  return {
    update: (newCurrent: number) => {
      current = newCurrent
      render()
    },
    increment: (amount = 1) => {
      current += amount
      render()
    },
    done: (summary: string) => {
      current = total
      render()
      process.stdout.write('\n')
      console.log(summary)
    },
  }
}
