import ROBadge from "@/components/reputation-os/ROBadge";
import type { RiskLevel } from "@/lib/nc/types";

const VARIANT: Record<RiskLevel, "low" | "medium" | "high" | "critical"> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

/** Risk-level pill that reuses the platform ROBadge styling. */
export default function RiskBadge({
  level,
  pulse,
}: {
  level: RiskLevel;
  pulse?: boolean;
}) {
  return (
    <ROBadge variant={VARIANT[level]} pulse={pulse && level === "CRITICAL"}>
      {level}
    </ROBadge>
  );
}
