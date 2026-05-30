const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const CompetitionFencer = sequelize.define('CompetitionFencer', {
    competition_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    fencer_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    seed: DataTypes.INTEGER,
    status: {
      type: DataTypes.STRING,
      defaultValue: 'registered'
    },
    state: DataTypes.STRING,
    final_rank: DataTypes.INTEGER
    // Add more competition-specific fields as needed
  }, {
    tableName: 'competition_fencers',
    timestamps: false
  });
  CompetitionFencer.associate = models => {
    CompetitionFencer.belongsTo(models.Competition, { foreignKey: 'competition_id' });
    CompetitionFencer.belongsTo(models.Fencer, { foreignKey: 'fencer_id' });
  };
  return CompetitionFencer;
};
