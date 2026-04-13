'use strict';

const path = require('path');
const fs   = require('fs');

let _config = null;

function loadConfig() {
  if (!_config) {
    _config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../rules/categories.json'), 'utf8')
    );
  }
  return _config;
}

/**
 * Derive a fencer's category ID from their date of birth and the competition year.
 *
 * @param {string} dateOfBirth  ISO-8601 date string (YYYY-MM-DD)
 * @param {number} competitionYear  e.g. 2026
 * @returns {string|null}  category id (e.g. "U17") or null if DOB is missing/invalid
 */
function deriveCategory(dateOfBirth, competitionYear) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return null;

  const { cutMonth, cutDay, categories } = loadConfig();

  // Age on the cut date of the competition year
  const cutDate = new Date(competitionYear, cutMonth - 1, cutDay);
  let age = cutDate.getFullYear() - dob.getFullYear();
  const monthDiff = cutDate.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && cutDate.getDate() < dob.getDate())) {
    age--;
  }

  const cat = categories.find(c => {
    const minOk = c.minAge === undefined || age >= c.minAge;
    const maxOk = c.maxAge === undefined || age <= c.maxAge;
    return minOk && maxOk;
  });

  return cat ? cat.id : null;
}

/**
 * Return the full list of category definitions (for populating filter dropdowns).
 */
function listCategories() {
  return loadConfig().categories;
}

module.exports = { deriveCategory, listCategories };
