const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Fencer = sequelize.define('Fencer', {
    ranking: DataTypes.INTEGER,
    status: {
      type: DataTypes.STRING,
      defaultValue: 'active'
    },
    initial_seed: DataTypes.INTEGER,
    weapons: DataTypes.TEXT, // JSON array as string
    licence: DataTypes.STRING,
    handedness: DataTypes.STRING,
    final_rank: DataTypes.INTEGER
  });
  Fencer.associate = models => {
    Fencer.belongsTo(models.Person, { foreignKey: 'personId' });
    // No direct club association; club is via Person
  };
  return Fencer;
};
