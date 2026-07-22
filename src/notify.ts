const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

export async function notify(message: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // silent fail — notifications are best-effort
  }
}

export async function notifyLiquidatable(
  user: string,
  hf: number,
  collateralUsd: number,
  debtUsd: number,
): Promise<void> {
  const profit = (collateralUsd * 0.5 * 0.05).toFixed(0);
  await notify(
    `🔴 <b>LIQUIDATION OPPORTUNITY</b>\n\n` +
    `User: <code>${user}</code>\n` +
    `Health Factor: <b>${hf.toFixed(4)}</b>\n` +
    `Collateral: $${collateralUsd.toFixed(0)}\n` +
    `Debt: $${debtUsd.toFixed(0)}\n` +
    `Est. profit: <b>~$${profit}</b> (5% bonus)\n\n` +
    `Chain: Base | Aave V3`,
  );
}

export async function notifyAtRisk(
  user: string,
  hf: number,
  debtUsd: number,
): Promise<void> {
  await notify(
    `🟡 <b>Position at risk</b>\n\n` +
    `User: <code>${user.slice(0, 14)}...</code>\n` +
    `HF: ${hf.toFixed(4)}\n` +
    `Debt: $${debtUsd.toFixed(0)}\n\n` +
    `May become liquidatable soon.`,
  );
}

export async function notifyExecuted(
  user: string,
  txHash: string,
  profitUsd: number,
): Promise<void> {
  await notify(
    `🎉 <b>LIQUIDATION EXECUTED</b>\n\n` +
    `User: <code>${user.slice(0, 14)}...</code>\n` +
    `Profit: <b>$${profitUsd.toFixed(0)}</b>\n` +
    `Tx: <code>${txHash}</code>\n\n` +
    `Chain: Base | Aave V3`,
  );
}

export async function notifyDailySummary(
  borrowers: number,
  atRisk: number,
  liquidatable: number,
  executed: number,
  totalProfit: number,
): Promise<void> {
  await notify(
    `📊 <b>Daily Summary</b>\n\n` +
    `Borrowers tracked: ${borrowers}\n` +
    `At risk (HF<1.1): ${atRisk}\n` +
    `Liquidatable: ${liquidatable}\n` +
    `Executed: ${executed}\n` +
    `Total profit: $${totalProfit.toFixed(0)}\n\n` +
    `Chain: Base | Aave V3`,
  );
}
