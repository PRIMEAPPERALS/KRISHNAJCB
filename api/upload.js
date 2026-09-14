export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {

    const { password, rows } = req.body;

    // Check admin password
    if (password !== process.env.ADMIN_UPLOAD_PASSWORD) {
      return res.status(401).json({
        error: "Invalid admin password"
      });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        error: "No stock data received"
      });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        error: "Supabase server settings are missing"
      });
    }

    // Delete old stock
    const deleteResponse = await fetch(
    SUPABASE_URL + "/rest/v1/branch_stock?Itemcode=not.is.null",
{
  method: "DELETE",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY
        }
      }
    );

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text();

      return res.status(500).json({
        error: "Could not delete old stock: " + errorText
      });
    }

    // Upload new stock in batches
    const batchSize = 500;

    for (let i = 0; i < rows.length; i += batchSize) {

      const batch = rows.slice(i, i + batchSize);

      const response = await fetch(
        SUPABASE_URL + "/rest/v1/branch_stock",
        {
          method: "POST",

          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },

          body: JSON.stringify(batch)
        }
      );

      if (!response.ok) {

        const errorText = await response.text();

        return res.status(500).json({
          error:
            "Upload failed at records " +
            i +
            "-" +
            (i + batch.length) +
            ": " +
            errorText
        });
      }
    }

    return res.status(200).json({
      success: true,
      records: rows.length
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: error.message
    });

  }
}
