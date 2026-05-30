const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Person = sequelize.define('Person', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    first_name: DataTypes.STRING,
    last_name: DataTypes.STRING,
    date_of_birth: DataTypes.DATE,
    club_id: {
      type: DataTypes.INTEGER,
      references: {
        model: 'clubs',
        key: 'id'
      },
      allowNull: true
    },
    nationality: {
      type: DataTypes.STRING(3),
      references: {
        model: 'nocs',
        key: 'code'
      }
    },
    gender: DataTypes.STRING(1) // M or F
  }, {
    tableName: 'people',
    timestamps: false
  });
  Person.associate = models => {
    Person.hasMany(models.Fencer, { foreignKey: 'person_id' });
    Person.belongsTo(models.NOC, { foreignKey: 'nationality', targetKey: 'code' });
    Person.belongsTo(models.Club, { foreignKey: 'club_id' });
  };
  return Person;
};
