//! Canonical memory store (SQLite) — the source of truth for the four-layer memory
//! (see docs/2026-11-08-four-layer-memory-architecture.md). Lives at ~/.aidt/memory.db
//! so it is durable, inspectable with any SQLite tool, portable (one file to copy or
//! back up), and NOT locked into the webview's localStorage origin.
//!
//! The TS store (src/memory.ts) fronts this with an in-memory cache so its read/query
//! API stays synchronous; it hydrates from `memory_read_all` at boot and write-through
//! every change via `memory_write_all`. The row count is small, so the write is a
//! coarse whole-table replace (simple + transactional); per-row ops can come later.

use rusqlite::Connection;
use std::path::PathBuf;

/// `~/.aidt/memory.db`, creating `~/.aidt` if needed. HOME on unix, USERPROFILE on
/// Windows — no extra crate needed.
fn db_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "no home directory".to_string())?;
    let dir = PathBuf::from(home).join(".aidt");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.join("memory.db"))
}

fn open() -> Result<Connection, String> {
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory (
            id         TEXT PRIMARY KEY,
            scope      TEXT NOT NULL,
            project_id TEXT,
            agent_id   TEXT,
            kind       TEXT NOT NULL,
            title      TEXT NOT NULL,
            body       TEXT NOT NULL,
            tags       TEXT NOT NULL,
            salience   REAL NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_memory_scope   ON memory(scope);
        CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Return every row as a JSON array whose objects match the TS `Memory` shape
/// (camelCase keys, `tags` as an array).
#[tauri::command]
pub fn memory_read_all() -> Result<String, String> {
    let conn = open()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, project_id, agent_id, kind, title, body, tags, salience, \
             created_at, updated_at, expires_at FROM memory",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let tags: String = r.get(7)?;
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "scope": r.get::<_, String>(1)?,
                "projectId": r.get::<_, Option<String>>(2)?,
                "agentId": r.get::<_, Option<String>>(3)?,
                "kind": r.get::<_, String>(4)?,
                "title": r.get::<_, String>(5)?,
                "body": r.get::<_, String>(6)?,
                "tags": serde_json::from_str::<serde_json::Value>(&tags)
                    .unwrap_or_else(|_| serde_json::json!([])),
                "salience": r.get::<_, f64>(8)?,
                "createdAt": r.get::<_, i64>(9)?,
                "updatedAt": r.get::<_, i64>(10)?,
                "expiresAt": r.get::<_, Option<i64>>(11)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    serde_json::to_string(&serde_json::Value::Array(out)).map_err(|e| e.to_string())
}

/// Replace the whole table with `json` (a JSON array of `Memory`). Transactional:
/// either the new set is stored or nothing changes.
#[tauri::command]
pub fn memory_write_all(json: String) -> Result<(), String> {
    let rows: Vec<serde_json::Value> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut conn = open()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memory", []).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO memory (id, scope, project_id, agent_id, kind, title, body, \
                 tags, salience, created_at, updated_at, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )
            .map_err(|e| e.to_string())?;
        for m in &rows {
            let tags = serde_json::to_string(m.get("tags").unwrap_or(&serde_json::json!([])))
                .unwrap_or_else(|_| "[]".to_string());
            stmt.execute(rusqlite::params![
                m.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                m.get("scope").and_then(|v| v.as_str()).unwrap_or("personal"),
                m.get("projectId").and_then(|v| v.as_str()),
                m.get("agentId").and_then(|v| v.as_str()),
                m.get("kind").and_then(|v| v.as_str()).unwrap_or("note"),
                m.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                m.get("body").and_then(|v| v.as_str()).unwrap_or(""),
                tags,
                m.get("salience").and_then(|v| v.as_f64()).unwrap_or(0.0),
                m.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0),
                m.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0),
                m.get("expiresAt").and_then(|v| v.as_i64()),
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
