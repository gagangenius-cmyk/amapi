#!/bin/sh
# Runs once, when the database volume is first created (mysql image: /docker-entrypoint-initdb.d).
# The API runs as this limited account: it can read and write data but cannot change the schema, drop tables
# or create triggers. Migrations use the root account separately (MIGRATE_DB_USER).
set -eu
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS 'aayme_app'@'%' IDENTIFIED BY '${APP_DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${MYSQL_DATABASE}\`.* TO 'aayme_app'@'%';
FLUSH PRIVILEGES;
SQL
