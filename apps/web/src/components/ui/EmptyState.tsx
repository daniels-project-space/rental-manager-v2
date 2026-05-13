export function EmptyState({
  message,
  icon = "○",
}: {
  message: string;
  icon?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 gap-2 text-[#8b8fa3]">
      <span className="text-2xl">{icon}</span>
      <p className="text-sm">{message}</p>
    </div>
  );
}
