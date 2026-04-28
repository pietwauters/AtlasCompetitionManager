const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const CompetitionFencer = sequelize.define('CompetitionFencer', {
    seed: DataTypes.INTEGER, // Competition-specific seed
    status: {
      type: DataTypes.STRING, // e.g. 'registered', 'present', 'dns', 'eliminated', 'finished', etc.
      defaultValue: 'registered'
    },
    state: DataTypes.STRING, // e.g. 'active', 'eliminated', etc.
    final_rank: DataTypes.INTEGER,
    // Add more competition-specific fields as needed
  });
  CompetitionFencer.associate = models => {
    CompetitionFencer.belongsTo(models.Competition, { foreignKey: 'competitionId' });
    CompetitionFencer.belongsTo(models.Fencer, { foreignKey: 'fencerId' });
  };
  return CompetitionFencer;
};
