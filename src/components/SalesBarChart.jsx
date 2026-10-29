export default function SalesBarChart({ data, formatMoney, barColor = '#8cc0b3' }) {
  const peak = Math.max(...data.map((item) => item.amount), 0)

  return (
    <div
      className="grid h-full grid-cols-7 items-end gap-2"
      role="img"
      aria-label={`Daily sales: ${data.map((item) => `${item.date || item.day}, ${formatMoney(item.amount)}`).join('; ')}`}
    >
      {data.map((item) => {
        const height = peak > 0 ? Math.max(3, (item.amount / peak) * 100) : 3
        return (
          <div key={item.date || item.day} className="flex h-full min-w-0 flex-col items-center justify-end gap-2">
            <div className="flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t-lg transition-[height] duration-300"
                style={{
                  height: `${height}%`,
                  backgroundColor: item.isPeak ? '#0e655d' : barColor,
                }}
                title={`${item.date || item.day}: ${formatMoney(item.amount)}`}
                aria-hidden="true"
              />
            </div>
            <span className="text-[10px] font-semibold text-[#718b82] sm:text-[11px]">{item.day}</span>
          </div>
        )
      })}
    </div>
  )
}
