'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { fetchText } = require('./util');
const { FABRIC_MAVEN } = require('./minecraft');

async function fabricApiTask(root, version, signal) {
  const rel = `net/fabricmc/fabric-api/fabric-api/${version}/fabric-api-${version}.jar`;
  const file = path.join(root, 'launcher', `fabric-api-${version}.jar`);
  const checksumFile = file + '.sha1';
  let sha1 = null;
  try {
    sha1 = (await fsp.readFile(checksumFile, 'utf8')).trim();
  } catch {
    try {
      sha1 = (await fetchText(`${FABRIC_MAVEN}/${rel}.sha1`, { signal })).trim().slice(0, 40);
      await fsp.mkdir(path.dirname(checksumFile), { recursive: true });
      await fsp.writeFile(checksumFile, sha1);
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  return { url: `${FABRIC_MAVEN}/${rel}`, sha1, file, deep: !!sha1 };
}

module.exports = { fabricApiTask };
