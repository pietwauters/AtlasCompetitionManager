const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Competition = sequelize.define('Competition', {
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    weapon: {
      type: DataTypes.STRING,
      allowNull: false
    },
    gender: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'draft'
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    date: DataTypes.DATE,
    // Add other competition fields as needed
  }, {
    tableName: 'competitions',
    timestamps: false
  });
  Competition.associate = models => {
    Competition.belongsToMany(models.Fencer, {
      through: models.CompetitionFencer,
      foreignKey: 'competitionId',
      otherKey: 'fencerId'
    });
    models.Fencer.belongsToMany(Competition, {
      through: models.CompetitionFencer,
      foreignKey: 'fencerId',
      otherKey: 'competitionId'
    });
    Competition.hasMany(models.CompetitionFencer, { foreignKey: 'competitionId' });
    models.Fencer.hasMany(models.CompetitionFencer, { foreignKey: 'fencerId' });
  };
  return Competition;
};
