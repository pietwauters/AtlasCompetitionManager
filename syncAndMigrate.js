// Script to sync all Sequelize models and migrate old fencer data
const { Sequelize } = require('sequelize');
const fs = require('fs');
const path = require('path');

// Load all models
const NOCModel = require('./models/noc');
const ClubModel = require('./models/club');
const PersonModel = require('./models/person');
const FencerModel = require('./models/fencer');

// NOC seed data (same as seedNOCs.js)
const nocList = [
  { code: "", country: "-----" },
  { code: "AFG", country: "Afghanistan" },
  { code: "AHO", country: "Netherlands Antilles" },
  { code: "ALB", country: "Albania" },
  { code: "ALG", country: "Algeria" },
  { code: "ANA", country: "Authorized Neutral Athlete" },
  { code: "AND", country: "Andorra" },
  { code: "ANG", country: "Angola" },
  { code: "ANT", country: "Antigua and Barbuda" },
  { code: "ARG", country: "Argentina" },
  { code: "ARM", country: "Armenia" },
  { code: "ARU", country: "Aruba" },
  { code: "ASA", country: "American Samoa" },
  { code: "AUS", country: "Australia" },
  { code: "AUT", country: "Austria" },
  { code: "AZE", country: "Azerbaijan" },
  { code: "BAH", country: "Bahamas" },
  { code: "BAN", country: "Bangladesh" },
  { code: "BAR", country: "Barbados" },
  { code: "BDI", country: "Burundi" },
  { code: "BEL", country: "Belgium" },
  { code: "BEN", country: "Benin" },
  { code: "BER", country: "Bermuda" },
  { code: "BHU", country: "Bhutan" },
  { code: "BIH", country: "Bosnia and Herzegovina" },
  { code: "BIZ", country: "Belize" },
  { code: "BLR", country: "Belarus" },
  { code: "BOL", country: "Bolivia" },
  { code: "BOT", country: "Botswana" },
  { code: "BRA", country: "Brazil" },
  { code: "BRN", country: "Bahrain" },
  { code: "BRU", country: "Brunei" },
  { code: "BUL", country: "Bulgaria" },
  { code: "BUR", country: "Burkina Faso" },
  { code: "CAF", country: "Central African Republic" },
  { code: "CAM", country: "Cambodia" },
  { code: "CAN", country: "Canada" },
  { code: "CAY", country: "Cayman Islands" },
  { code: "CGO", country: "Congo" },
  { code: "CHA", country: "Chad" },
  { code: "CHI", country: "Chile" },
  { code: "CHN", country: "China" },
  { code: "CIV", country: "Cote d'Ivoire" },
  { code: "CMR", country: "Cameroon" },
  { code: "COD", country: "DR Congo" },
  { code: "COK", country: "Cook Islands" },
  { code: "COL", country: "Colombia" },
  { code: "COM", country: "Comoros" },
  { code: "CPV", country: "Cape Verde" },
  { code: "CRC", country: "Costa Rica" },
  { code: "CRO", country: "Croatia" },
  { code: "CUB", country: "Cuba" },
  { code: "CYP", country: "Cyprus" },
  { code: "CZE", country: "Czech Republic" },
  { code: "DEN", country: "Denmark" },
  { code: "DJI", country: "Djibouti" },
  { code: "DMA", country: "Dominica" },
  { code: "DOM", country: "Dominican Republic" },
  { code: "ECU", country: "Ecuador" },
  { code: "EGY", country: "Egypt" },
  { code: "ERI", country: "Eritrea" },
  { code: "ESA", country: "El Salvador" },
  { code: "ESP", country: "Spain" },
  { code: "EST", country: "Estonia" },
  { code: "ETH", country: "Ethiopia" },
  { code: "FIJ", country: "Fiji" },
  { code: "FIN", country: "Finland" },
  { code: "FRA", country: "France" },
  { code: "FSM", country: "Micronesia" },
  { code: "GAB", country: "Gabon" },
  { code: "GAM", country: "Gambia" },
  { code: "GBR", country: "Great Britain" },
  { code: "GBS", country: "Guinea-Bissau" },
  { code: "GEO", country: "Georgia" },
  { code: "GEQ", country: "Equatorial Guinea" },
  { code: "GER", country: "Germany" },
  { code: "GHA", country: "Ghana" },
  { code: "GRE", country: "Greece" },
  { code: "GRN", country: "Grenada" },
  { code: "GUA", country: "Guatemala" },
  { code: "GUI", country: "Guinea" },
  { code: "GUM", country: "Guam" },
  { code: "GUY", country: "Guyana" },
  { code: "HAI", country: "Haiti" },
  { code: "HKG", country: "Hong Kong" },
  { code: "HON", country: "Honduras" },
  { code: "HUN", country: "Hungary" },
  { code: "INA", country: "Indonesia" },
  { code: "IND", country: "India" },
  { code: "IRI", country: "Iran" },
  { code: "IRL", country: "Ireland" },
  { code: "IRQ", country: "Iraq" },
  { code: "ISL", country: "Iceland" },
  { code: "ISR", country: "Israel" },
  { code: "ISV", country: "Virgin Islands" },
  { code: "ITA", country: "Italy" },
  { code: "IVB", country: "British Virgin Islands" },
  { code: "JAM", country: "Jamaica" },
  { code: "JOR", country: "Jordan" },
  { code: "JPN", country: "Japan" },
  { code: "KAZ", country: "Kazakhstan" },
  { code: "KEN", country: "Kenya" },
  { code: "KGZ", country: "Kyrgyzstan" },
  { code: "KIR", country: "Kiribati" },
  { code: "KOR", country: "South Korea" },
  { code: "KSA", country: "Saudi Arabia" },
  { code: "KUW", country: "Kuwait" },
  { code: "LAO", country: "Laos" },
  { code: "LAT", country: "Latvia" },
  { code: "LBA", country: "Libya" },
  { code: "LBR", country: "Liberia" },
  { code: "LCA", country: "Saint Lucia" },
  { code: "LES", country: "Lesotho" },
  { code: "LIB", country: "Lebanon" },
  { code: "LIE", country: "Liechtenstein" },
  { code: "LTU", country: "Lithuania" },
  { code: "LUX", country: "Luxembourg" },
  { code: "MAD", country: "Madagascar" },
  { code: "MAR", country: "Morocco" },
  { code: "MAS", country: "Malaysia" },
  { code: "MAW", country: "Malawi" },
  { code: "MDA", country: "Moldova" },
  { code: "MDV", country: "Maldives" },
  { code: "MEX", country: "Mexico" },
  { code: "MGL", country: "Mongolia" },
  { code: "MHL", country: "Marshall Islands" },
  { code: "MKD", country: "Macedonia" },
  { code: "MLI", country: "Mali" },
  { code: "MLT", country: "Malta" },
  { code: "MNE", country: "Montenegro" },
  { code: "MON", country: "Monaco" },
  { code: "MOZ", country: "Mozambique" },
  { code: "MRI", country: "Mauritius" },
  { code: "MTN", country: "Mauritania" },
  { code: "MYA", country: "Myanmar" },
  { code: "NAM", country: "Namibia" },
  { code: "NCA", country: "Nicaragua" },
  { code: "NED", country: "Netherlands" },
  { code: "NEP", country: "Nepal" },
  { code: "NGR", country: "Nigeria" },
  { code: "NIG", country: "Niger" },
  { code: "NOR", country: "Norway" },
  { code: "NRU", country: "Nauru" },
  { code: "NZL", country: "New Zealand" },
  { code: "OMA", country: "Oman" },
  { code: "PAK", country: "Pakistan" },
  { code: "PAN", country: "Panama" },
  { code: "PAR", country: "Paraguay" },
  { code: "PER", country: "Peru" },
  { code: "PHI", country: "Philippines" },
  { code: "PLE", country: "Palestine" },
  { code: "PLW", country: "Palau" },
  { code: "PNG", country: "Papua New Guinea" },
  { code: "POL", country: "Poland" },
  { code: "POR", country: "Portugal" },
  { code: "PRK", country: "North Korea" },
  { code: "PUR", country: "Puerto Rico" },
  { code: "QAT", country: "Qatar" },
  { code: "ROU", country: "Romania" },
  { code: "RSA", country: "South Africa" },
  { code: "RUS", country: "Russia" },
  { code: "RWA", country: "Rwanda" },
  { code: "SAM", country: "Samoa" },
  { code: "SEN", country: "Senegal" },
  { code: "SEY", country: "Seychelles" },
  { code: "SIN", country: "Singapore" },
  { code: "SKN", country: "Saint Kitts and Nevis" },
  { code: "SLE", country: "Sierra Leone" },
  { code: "SLO", country: "Slovenia" },
  { code: "SMR", country: "San Marino" },
  { code: "SOL", country: "Solomon Islands" },
  { code: "SOM", country: "Somalia" },
  { code: "SRB", country: "Serbia" },
  { code: "SRI", country: "Sri Lanka" },
  { code: "STP", country: "Sao Tome and Príncipe" },
  { code: "SUD", country: "Sudan" },
  { code: "SUI", country: "Switzerland" },
  { code: "SUR", country: "Suriname" },
  { code: "SVK", country: "Slovakia" },
  { code: "SWE", country: "Sweden" },
  { code: "SWZ", country: "Swaziland" },
  { code: "SYR", country: "Syria" },
  { code: "TAN", country: "Tanzania" },
  { code: "TGA", country: "Tonga" },
  { code: "THA", country: "Thailand" },
  { code: "TJK", country: "Tajikistan" },
  { code: "TKM", country: "Turkmenistan" },
  { code: "TLS", country: "Timor-Leste" },
  { code: "TOG", country: "Togo" },
  { code: "TPE", country: "Chinese Taipei" },
  { code: "TRI", country: "Trinidad and Tobago" },
  { code: "TUN", country: "Tunisia" },
  { code: "TUR", country: "Turkey" },
  { code: "TUV", country: "Tuvalu" },
  { code: "UAE", country: "United Arab Emirates" },
  { code: "UGA", country: "Uganda" },
  { code: "UKR", country: "Ukraine" },
  { code: "URU", country: "Uruguay" },
  { code: "USA", country: "United States" },
  { code: "UZB", country: "Uzbekistan" },
  { code: "VAN", country: "Vanuatu" },
  { code: "VEN", country: "Venezuela" },
  { code: "VIE", country: "Vietnam" },
  { code: "VIN", country: "Saint Vincent and the Grenadines" },
  { code: "YEM", country: "Yemen" },
  { code: "ZAM", country: "Zambia" },
  { code: "ZIM", country: "Zimbabwe" }
];

async function main() {
  // Setup Sequelize (adjust DB path as needed)
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './data/atlas.db',
    logging: false
  });

  // Init models
  const NOC = NOCModel(sequelize);
  const Club = ClubModel(sequelize);
  const Person = PersonModel(sequelize);
  const Fencer = FencerModel(sequelize);

  // Setup associations
  const models = { NOC, Club, Person, Fencer };
  if (NOC.associate) NOC.associate(models);
  if (Club.associate) Club.associate(models);
  if (Person.associate) Person.associate(models);
  if (Fencer.associate) Fencer.associate(models);

  // Sync all models
  await sequelize.sync({ alter: true });
  console.log('All models synced.');

  // Seed NOC table
  for (const entry of nocList) {
    await NOC.findOrCreate({ where: { code: entry.code }, defaults: { country: entry.country } });
  }
  console.log('NOC table populated.');

  // --- Data migration example ---
  // If you have an old fencer table, migrate data here.
  // Example: read old data and insert into new tables.
  // You may need to adjust table/column names below.
  try {
    const oldDbPath = path.join(__dirname, 'data', 'atlas.db');
    const oldSequelize = new Sequelize({
      dialect: 'sqlite',
      storage: oldDbPath,
      logging: false
    });
    // Read old fencer data (adjust table/column names as needed)
    const [oldFencers] = await oldSequelize.query('SELECT * FROM fencers');
    for (const old of oldFencers) {
      // Find or create club
      let clubInstance = null;
      if (old.club) {
        [clubInstance] = await Club.findOrCreate({ where: { name: old.club } });
      }
      // Find or create person
      const [person] = await Person.findOrCreate({
        where: {
          firstName: old.firstName,
          lastName: old.lastName,
          birthdate: old.birthdate
        },
        defaults: {
          clubId: clubInstance ? clubInstance.id : null,
          nationality: old.nationality
        }
      });
      // Create fencer
      await Fencer.findOrCreate({
        where: { personId: person.id },
        defaults: {
          ranking: old.ranking
        }
      });
    }
    console.log('Fencer data migrated.');
    await oldSequelize.close();
  } catch (e) {
    console.warn('Fencer migration skipped or failed:', e.message);
  }

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
