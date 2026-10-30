ALTER TABLE registry ADD COLUMN source TEXT NOT NULL DEFAULT 'git' CHECK(source IN ('git', 'local'));
