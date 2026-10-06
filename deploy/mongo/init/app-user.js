// First start of an empty database only (the image runs /docker-entrypoint-initdb.d once,
// as the root user of MONGO_INITDB_ROOT_*): the app's own user, read and write on kibbl.
db.getSiblingDB('kibbl').createUser({
    user: process.env.MONGO_APP_USER,
    pwd: process.env.MONGO_APP_PASSWORD,
    roles: [{ role: 'readWrite', db: 'kibbl' }],
});
