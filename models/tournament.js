const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Tournament = sequelize.define('Tournament', {
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    city: DataTypes.STRING,
    country: DataTypes.STRING,
    date_start: DataTypes.DATE,
    date_end: DataTypes.DATE,
    organizer: DataTypes.STRING,
    description: DataTypes.TEXT,
    level: DataTypes.STRING,
    status: {
      type: DataTypes.STRING,
      defaultValue: 'open'
    },
    archived: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'tournaments',
    timestamps: false
  });
  Tournament.associate = models => {
    Tournament.hasMany(models.Competition, { foreignKey: 'tournament_id' });
  };
  return Tournament;
};
