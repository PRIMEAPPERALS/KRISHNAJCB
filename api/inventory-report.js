export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { password } = req.body || {};

    if (password !== process.env.ADMIN_UPLOAD_PASSWORD) {
      return res.status(401).json({ error: "Invalid admin password" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        error: "Supabase server settings are missing"
      });
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY
    };

    // Existing backend analysis view used by Krishna Stock.
    // Expected columns:
    // Itemcode, ItemName, Branch, CurrentStock, SalesQty12M, MovementStatus
    const allRows = [];
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const url =
        SUPABASE_URL +
        "/rest/v1/stock_movement_analysis?select=Itemcode,ItemName,Branch,CurrentStock,SalesQty12M,MovementStatus&limit=" +
        pageSize +
        "&offset=" +
        offset;

      const response = await fetch(url, {
        headers: {
          ...headers,
          Prefer: "count=exact"
        }
      });

      if (!response.ok) {
        throw new Error("Could not read stock movement analysis: " + await response.text());
      }

      const batch = await response.json();
      allRows.push(...batch);

      if (batch.length < pageSize) break;
      offset += pageSize;
    }

    // Price master is used only to calculate value of excess stock
    // and potential sale-loss / transfer quantities.
    const masterResponse = await fetch(
      SUPABASE_URL +
        "/rest/v1/part_master?select=Itemcode,ItemName,MRP&limit=100000",
      { headers }
    );

    if (!masterResponse.ok) {
      throw new Error("Could not read part master: " + await masterResponse.text());
    }

    const masterRows = await masterResponse.json();
    const masterMap = {};

    masterRows.forEach(row => {
      const key = String(row.Itemcode || "").trim().toUpperCase();
      if (key) {
        masterMap[key] = {
          name: row.ItemName || "",
          mrp: Number(row.MRP) || 0
        };
      }
    });

    const normalized = allRows.map(row => {
      const itemcode = String(row.Itemcode || "").trim().toUpperCase();
      const stock = Number(row.CurrentStock) || 0;
      const sales12m = Number(row.SalesQty12M) || 0;
      const avgMonthlySales = sales12m / 12;
      const required2M = avgMonthlySales * 2;
      const excessQty = Math.max(0, stock - required2M);
      const shortageQty = Math.max(0, required2M - stock);
      const master = masterMap[itemcode] || {};

      return {
        itemcode,
        itemName: row.ItemName || master.name || "",
        branch: String(row.Branch || "").trim().toUpperCase(),
        currentStock: stock,
        salesQty12M: sales12m,
        avgMonthlySales,
        requiredStock2M: required2M,
        excessQty,
        shortageQty,
        movementStatus: row.MovementStatus || "",
        mrp: Number(master.mrp) || 0
      };
    });

    // 1) EXCESS STOCK
    const excessStock = normalized
      .filter(r => r.excessQty > 0)
      .map(r => ({
        itemcode: r.itemcode,
        itemName: r.itemName,
        branch: r.branch,
        currentStock: r.currentStock,
        salesQty12M: r.salesQty12M,
        avgMonthlySales: Number(r.avgMonthlySales.toFixed(2)),
        requiredStock2M: Number(r.requiredStock2M.toFixed(2)),
        excessQty: Number(r.excessQty.toFixed(2)),
        excessValue: Number((r.excessQty * r.mrp).toFixed(2)),
        mrp: r.mrp,
        movementStatus: r.movementStatus
      }))
      .sort((a, b) => b.excessValue - a.excessValue);

    // 2) STOCKOUT / SALE LOSS
    // A stockout is a branch with zero/negative stock but positive 12M demand.
    // Sale-loss potential is calculated as two months of demonstrated demand,
    // consistent with the current 2-month stock-cover logic.
    const stockoutSaleLoss = normalized
      .filter(r => r.currentStock <= 0 && r.salesQty12M > 0)
      .map(r => {
        const potentialQty = r.avgMonthlySales * 2;
        return {
          itemcode: r.itemcode,
          itemName: r.itemName,
          branch: r.branch,
          currentStock: r.currentStock,
          salesQty12M: r.salesQty12M,
          avgMonthlySales: Number(r.avgMonthlySales.toFixed(2)),
          saleLossPotentialQty2M: Number(potentialQty.toFixed(2)),
          saleLossPotentialValue: Number((potentialQty * r.mrp).toFixed(2)),
          mrp: r.mrp,
          movementStatus: r.movementStatus
        };
      })
      .sort((a, b) => b.saleLossPotentialValue - a.saleLossPotentialValue);

    // 3) TRANSFER OPPORTUNITY
    // Match excess stock at one branch with shortage at another branch
    // for the same part. Transfer quantity is limited by both source excess
    // and destination 2-month requirement.
    const grouped = {};

    normalized.forEach(r => {
      if (!grouped[r.itemcode]) grouped[r.itemcode] = [];
      grouped[r.itemcode].push(r);
    });

    const transferOpportunities = [];

    Object.entries(grouped).forEach(([itemcode, branches]) => {
      const sources = branches
        .filter(r => r.excessQty > 0)
        .map(r => ({ ...r, remainingExcess: r.excessQty }))
        .sort((a, b) => b.remainingExcess - a.remainingExcess);

      const destinations = branches
        .filter(r => r.shortageQty > 0)
        .map(r => ({ ...r, remainingNeed: r.shortageQty }))
        .sort((a, b) => b.remainingNeed - a.remainingNeed);

      sources.forEach(source => {
        destinations.forEach(destination => {
          if (source.remainingExcess <= 0 || destination.remainingNeed <= 0) return;
          if (source.branch === destination.branch) return;

          const transferQty = Math.min(
            source.remainingExcess,
            destination.remainingNeed
          );

          if (transferQty <= 0) return;

          transferOpportunities.push({
            itemcode,
            itemName: source.itemName || destination.itemName,
            fromBranch: source.branch,
            toBranch: destination.branch,
            sourceStock: source.currentStock,
            destinationStock: destination.currentStock,
            sourceMovement: source.movementStatus,
            destinationMovement: destination.movementStatus,
            salesQty12MAtDestination: destination.salesQty12M,
            avgMonthlySalesAtDestination: Number(destination.avgMonthlySales.toFixed(2)),
            transferQty: Number(transferQty.toFixed(2)),
            transferValue: Number((transferQty * source.mrp).toFixed(2)),
            reason:
              "Excess stock at source + 2-month demand requirement at destination"
          });

          source.remainingExcess -= transferQty;
          destination.remainingNeed -= transferQty;
        });
      });
    });

    transferOpportunities.sort((a, b) => b.transferValue - a.transferValue);

    const summary = {
      analysisBasis: "12-month sales with 2-month required stock cover",
      totalRowsAnalysed: normalized.length,
      excessStockLines: excessStock.length,
      excessStockValue: Number(
        excessStock.reduce((sum, r) => sum + r.excessValue, 0).toFixed(2)
      ),
      stockoutSaleLossLines: stockoutSaleLoss.length,
      saleLossPotentialValue: Number(
        stockoutSaleLoss.reduce((sum, r) => sum + r.saleLossPotentialValue, 0).toFixed(2)
      ),
      transferOpportunityLines: transferOpportunities.length,
      transferOpportunityValue: Number(
        transferOpportunities.reduce((sum, r) => sum + r.transferValue, 0).toFixed(2)
      )
    };

    return res.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      summary,
      excessStock,
      stockoutSaleLoss,
      transferOpportunities
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message
    });
  }
}
