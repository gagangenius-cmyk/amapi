-- Files kept in the database, for hosts with no writable disk and no object-storage bucket (STORAGE=db, or a serverless host).
-- Product photos (max 1.5 MB), support attachments and generated reports all go through the same small storage interface.
CREATE TABLE file_blobs (
  file_key VARCHAR(190) NOT NULL PRIMARY KEY,
  mime VARCHAR(100) NOT NULL,
  data MEDIUMBLOB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
