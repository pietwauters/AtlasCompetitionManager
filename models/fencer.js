const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Fencer = sequelize.define('Fencer', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    person_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'people',
        key: 'id'
      }
    },
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
  }, {
    tableName: 'fencers',
    timestamps: false
  });
  Fencer.associate = models => {
    Fencer.belongsTo(models.Person, { foreignKey: 'person_id' });
    // No direct club association; club is via Person
  };
  return Fencer;
};
