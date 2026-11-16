CREATE TABLE "operator_inbox" (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       type TEXT NOT NULL,
       data BLOB,
       tags TEXT NOT NULL,
       uuid TEXT NOT NULL,
       occurred_at TEXT NOT NULL
     );

CREATE TABLE "operator_inbox_tags" (
       tag TEXT NOT NULL,
       main_id INTEGER NOT NULL REFERENCES "operator_inbox" (id),
       PRIMARY KEY (tag, main_id)
     ) WITHOUT ROWID;

CREATE TRIGGER "operator_inbox_tag_fanout"
     AFTER INSERT ON "operator_inbox"
     FOR EACH ROW
     BEGIN
       INSERT OR IGNORE INTO "operator_inbox_tags" (tag, main_id)
       SELECT json_each.value, NEW.id
       FROM json_each(NEW.tags);
     END;
