const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Competition = sequelize.define('Competition', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
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
    date: {
      type: DataTypes.DATE
    }
    // Add other competition fields as needed
  }, {
    tableName: 'competitions',
    timestamps: false
  });
  Competition.associate = models => {
    Competition.belongsToMany(models.Fencer, {
      through: models.CompetitionFencer,
      foreignKey: 'competition_id',
      otherKey: 'fencer_id'
    });
    models.Fencer.belongsToMany(Competition, {
      through: models.CompetitionFencer,
      foreignKey: 'fencer_id',
      otherKey: 'competition_id'
    });
    Competition.hasMany(models.CompetitionFencer, { foreignKey: 'competition_id' });
    models.Fencer.hasMany(models.CompetitionFencer, { foreignKey: 'fencer_id' });
  };
  return Competition;
};
