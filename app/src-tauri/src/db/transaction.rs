use rusqlite::Connection;

/// Run `work` inside BEGIN/COMMIT, rolling back and returning the original
/// error if it fails. Works with a shared `&Connection`.
pub fn transaction<T, E>(conn: &Connection, work: impl FnOnce() -> Result<T, E>) -> Result<T, E>
where
    E: From<rusqlite::Error>,
{
    conn.execute_batch("BEGIN")?;
    match work() {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commits_successful_writes_and_returns_the_result() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE item (name TEXT)").unwrap();
        let result: Result<&str, rusqlite::Error> = transaction(&db, || {
            db.execute("INSERT INTO item VALUES (?1)", ["kept"])?;
            Ok("result")
        });
        assert_eq!(result.unwrap(), "result");
        let name: String = db
            .query_row("SELECT name FROM item", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "kept");
    }

    #[test]
    fn rolls_back_every_write_and_returns_the_original_error() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE item (name TEXT)").unwrap();
        let result: Result<(), String> = {
            struct Wrapped(String);
            impl From<rusqlite::Error> for Wrapped {
                fn from(e: rusqlite::Error) -> Self {
                    Wrapped(e.to_string())
                }
            }
            transaction(&db, || -> Result<(), Wrapped> {
                db.execute("INSERT INTO item VALUES (?1)", ["discarded"])?;
                db.execute("INSERT INTO item VALUES (?1)", ["also discarded"])?;
                Err(Wrapped("failed".into()))
            })
            .map_err(|e| e.0)
        };
        assert_eq!(result.unwrap_err(), "failed");
        let count: i64 = db
            .query_row("SELECT count(*) FROM item", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
